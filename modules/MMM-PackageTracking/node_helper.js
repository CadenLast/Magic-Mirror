const NodeHelper = require("node_helper");
const Log = require("logger");
const fs = require("fs");
const path = require("path");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const GMAIL_QUERY = [
	"newer_than:30d",
	"(from:ups.com OR from:fedex.com OR from:usps.com OR from:amazon.com",
	"OR from:dhl.com OR from:narvar.com OR from:chewy.com",
	"OR from:manapool.com OR from:tcgplayer.com",
	"OR subject:\"has shipped\" OR subject:\"tracking number\"",
	"OR subject:\"shipment notification\" OR subject:\"out for delivery\"",
	"OR subject:\"delivery notification\" OR subject:\"was delivered\"",
	"OR subject:\"delivery update\")"
].join(" ");

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

module.exports = NodeHelper.create({
	start () {
		Log.log(`Starting node helper for: ${this.name}`);
		this.tokens = null;
		this.packages = new Map();
		this.routesRegistered = false;
		this.scanTimer = null;
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "INIT_TRACKING") {
			this.init(payload);
		} else if (notification === "FETCH_TRACKING") {
			this.sendPackages();
		}
	},

	async init (config) {
		this.config = config;

		if (config.gmail?.clientId && !this.routesRegistered) {
			this.registerRoutes(config);
			this.routesRegistered = true;
		}

		for (const pkg of (config.packages || [])) {
			this.packages.set(pkg.trackingNumber, {
				id: pkg.trackingNumber,
				carrier: pkg.carrier || "",
				carrierName: (pkg.carrier || "").toUpperCase(),
				name: pkg.name || pkg.trackingNumber,
				status: "InTransit",
				statusMessage: "In transit",
				expectedDelivery: null,
				lastUpdate: null,
				source: "manual"
			});
		}

		if (config.gmail?.clientId) {
			this.tokens = this.loadTokens();
			if (this.tokens) {
				this.sendSocketNotification("GMAIL_STATUS", { connected: true });
				await this.scanGmail();
				this.scheduleScan();
			} else {
				this.sendSocketNotification("GMAIL_STATUS", { connected: false });
			}
		}

		this.sendPackages();
	},

	scheduleScan () {
		if (this.scanTimer) clearInterval(this.scanTimer);
		const interval = this.config?.emailScanInterval || 15 * 60 * 1000;
		this.scanTimer = setInterval(async () => {
			await this.scanGmail();
			this.sendPackages();
		}, interval);
	},

	sendPackages () {
		const now = new Date();
		now.setHours(0, 0, 0, 0);

		const list = Array.from(this.packages.values());

		// If delivery date has passed and status is still InTransit/Pending,
		// mark as presumed delivered (no confirmation email from Amazon)
		for (const pkg of list) {
			if (pkg.expectedDelivery && (pkg.status === "InTransit" || pkg.status === "Pending")) {
				const eta = new Date(pkg.expectedDelivery + "T23:59:59");
				if (eta < now) {
					pkg.status = "Presumed";
					pkg.statusMessage = "Likely delivered";
					pkg.deliveredAt = pkg.expectedDelivery;
				}
			}
		}

		const isDone = (s) => s === "Delivered" || s === "Presumed";
		list.sort((a, b) => {
			const aDone = isDone(a.status);
			const bDone = isDone(b.status);
			if (aDone !== bDone) return aDone ? 1 : -1;

			if (!aDone) {
				// Active: soonest expected delivery first, then by urgency
				const statusOrder = { OutForDelivery: 0, InTransit: 1, Pending: 2 };
				const aOrder = statusOrder[a.status] ?? 2;
				const bOrder = statusOrder[b.status] ?? 2;
				if (a.expectedDelivery && b.expectedDelivery) return new Date(a.expectedDelivery) - new Date(b.expectedDelivery);
				if (a.expectedDelivery) return -1;
				if (b.expectedDelivery) return 1;
				return aOrder - bOrder;
			}

			// Done: most recent delivery date first
			const aDate = a.deliveredAt || a.expectedDelivery;
			const bDate = b.deliveredAt || b.expectedDelivery;
			if (aDate && bDate) return new Date(bDate) - new Date(aDate);
			if (aDate) return -1;
			if (bDate) return 1;
			return 0;
		});
		this.sendSocketNotification("TRACKING_DATA", list);
	},

	// --- OAuth Routes ---

	registerRoutes (config) {
		const redirectUri = this.getRedirectUri(config);

		this.expressApp.get(`/${this.name}/auth`, (req, res) => {
			const params = new URLSearchParams({
				client_id: config.gmail.clientId,
				redirect_uri: redirectUri,
				response_type: "code",
				scope: GMAIL_SCOPE,
				access_type: "offline",
				prompt: "consent"
			});
			res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
		});

		this.expressApp.get(`/${this.name}/callback`, async (req, res) => {
			const code = req.query.code;
			if (!code) {
				res.status(400).send("Missing authorization code");
				return;
			}

			try {
				const tokens = await this.exchangeCode(code, config);
				this.tokens = tokens;
				this.saveTokens(tokens);
				this.sendSocketNotification("GMAIL_STATUS", { connected: true });

				res.send(`<html><body style="background:#000;color:#2ecc71;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
					<div style="text-align:center"><h1>Gmail Connected</h1><p>You can close this tab. The mirror will start scanning for packages.</p></div>
				</body></html>`);

				await this.scanGmail();
				this.sendPackages();
				this.scheduleScan();
			} catch (error) {
				Log.error(`${this.name}: OAuth error:`, error.message);
				res.status(500).send(`Auth failed: ${error.message}`);
			}
		});
	},

	getRedirectUri (config) {
		if (config.gmail?.redirectUri) return config.gmail.redirectUri;
		const addr = config.address || "localhost";
		const port = config.port || 8080;
		return `http://${addr}:${port}/${this.name}/callback`;
	},

	// --- Token Management ---

	getTokenPath () {
		return path.join(this.path, "gmail_tokens.json");
	},

	loadTokens () {
		try {
			return JSON.parse(fs.readFileSync(this.getTokenPath(), "utf8"));
		} catch {
			return null;
		}
	},

	saveTokens (tokens) {
		fs.writeFileSync(this.getTokenPath(), JSON.stringify(tokens, null, 2));
	},

	async exchangeCode (code, config) {
		const response = await fetch(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				code,
				client_id: config.gmail.clientId,
				client_secret: config.gmail.clientSecret,
				redirect_uri: this.getRedirectUri(config),
				grant_type: "authorization_code"
			})
		});
		const data = await response.json();
		if (!response.ok) throw new Error(data.error_description || data.error);
		return {
			access_token: data.access_token,
			refresh_token: data.refresh_token,
			expires_at: Date.now() + data.expires_in * 1000
		};
	},

	async getAccessToken () {
		if (!this.tokens) return null;
		if (Date.now() > this.tokens.expires_at - 60000) {
			const response = await fetch(GOOGLE_TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					refresh_token: this.tokens.refresh_token,
					client_id: this.config.gmail.clientId,
					client_secret: this.config.gmail.clientSecret,
					grant_type: "refresh_token"
				})
			});
			const data = await response.json();
			if (!response.ok) {
				this.tokens = null;
				try { fs.unlinkSync(this.getTokenPath()); } catch { /* ignore */ }
				this.sendSocketNotification("GMAIL_STATUS", { connected: false });
				throw new Error("Token refresh failed — re-auth required");
			}
			this.tokens.access_token = data.access_token;
			this.tokens.expires_at = Date.now() + data.expires_in * 1000;
			this.saveTokens(this.tokens);
		}
		return this.tokens.access_token;
	},

	// --- Gmail Scanning ---

	async scanGmail () {
		try {
			const accessToken = await this.getAccessToken();
			if (!accessToken) return;

			// Paginate through all matching emails
			const messages = [];
			let pageToken = null;
			do {
				let url = `${GMAIL_API}/messages?q=${encodeURIComponent(GMAIL_QUERY)}&maxResults=100`;
				if (pageToken) url += `&pageToken=${pageToken}`;
				const listResp = await fetch(url, {
					headers: { Authorization: `Bearer ${accessToken}` }
				});
				if (!listResp.ok) {
					Log.error(`${this.name}: Gmail search failed: ${listResp.status}`);
					return;
				}
				const listData = await listResp.json();
				if (listData.messages) messages.push(...listData.messages);
				pageToken = listData.nextPageToken || null;
			} while (pageToken);

			const emailData = [];
			for (const msg of messages) {
				const email = await this.fetchEmail(accessToken, msg.id);
				if (email) emailData.push(email);
			}

			// Sort by date ascending so newer emails overwrite older ones
			emailData.sort((a, b) => (a.date || 0) - (b.date || 0));

			for (const email of emailData) {
				const from = (email.from || "").toLowerCase();
				if (this.isAmazonEmail(from)) {
					this.processAmazonEmail(email);
				} else if (this.isChewyEmail(from)) {
					this.processChewyEmail(email);
				} else if (from.includes("manapool.com")) {
					this.processManaPoolEmail(email);
				} else if (from.includes("tcgplayer.com")) {
					this.processTCGPlayerEmail(email);
				} else {
					this.processCarrierEmail(email);
				}
			}

			Log.info(`${this.name}: Scanned ${messages.length} emails, tracking ${this.packages.size} packages`);
		} catch (error) {
			Log.error(`${this.name}: Gmail scan error:`, error.message);
		}
	},

	async fetchEmail (accessToken, messageId) {
		try {
			const resp = await fetch(`${GMAIL_API}/messages/${messageId}?format=full`, {
				headers: { Authorization: `Bearer ${accessToken}` }
			});
			if (!resp.ok) return null;

			const data = await resp.json();
			const headers = data.payload?.headers || [];
			const getHeader = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

			const dateStr = getHeader("Date");
			const textBody = this.extractBodyByType(data.payload, "text/plain") || "";
			const htmlBody = this.extractBodyByType(data.payload, "text/html") || "";

			return {
				from: getHeader("From"),
				subject: getHeader("Subject"),
				date: dateStr ? new Date(dateStr) : null,
				text: textBody.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
				html: htmlBody
			};
		} catch {
			return null;
		}
	},

	extractBodyByType (payload, mimeType) {
		if (!payload) return "";
		if (payload.mimeType === mimeType && payload.body?.data) {
			return Buffer.from(payload.body.data, "base64url").toString("utf8");
		}
		if (payload.parts) {
			for (const part of payload.parts) {
				const result = this.extractBodyByType(part, mimeType);
				if (result) return result;
			}
		}
		return "";
	},

	isAmazonEmail (from) {
		return (from || "").toLowerCase().includes("amazon.com");
	},

	isChewyEmail (from) {
		return (from || "").toLowerCase().includes("chewy.com");
	},

	// --- Amazon Email Processing ---

	processAmazonEmail (email) {
		const subject = email.subject || "";
		const text = email.text || "";
		const emailDate = email.date;
		const from = (email.from || "").toLowerCase();

		// Skip returns, refunds, and non-delivery emails
		if (from.includes("return@") || /^Return/i.test(subject) || /refund/i.test(subject)) return;

		// Extract order number: "Order #\n113-XXXX-XXXX"
		const orderMatch = text.match(/Order\s*#\s*\n?\s*([\d-]+)/);
		if (!orderMatch) return;
		const orderId = orderMatch[1];

		// Use orderId as the package key. Multi-shipment orders merge into one
		// entry — the most recent email's status wins.
		const pkgKey = orderId;

		// Parse item name from subject: Shipped: "Item Name..." [and N more items]
		const itemMatch = subject.match(/(?:Ordered|Shipped|Delivered|Delivery update):\s*(?:[⁦⁩\d]+\s*)?"([^"]+)"/);
		const itemName = itemMatch ? itemMatch[1].replace(/\s*\.{3}$/, "").trim() : null;
		const moreItems = subject.match(/and\s*⁦?(\d+)⁩?\s*more\s+item/i);
		const itemCount = moreItems ? parseInt(moreItems[1]) + 1 : 1;
		const displayName = itemName
			? (itemCount > 1 ? `${itemName} +${itemCount - 1} more` : itemName)
			: `Amazon Order ${orderId.slice(-7)}`;

		// Determine status from subject prefix and body (NOT progress bar)
		let status = "Pending";
		let statusMessage = "Ordered";
		if (/^Delivered:/i.test(subject)) {
			status = "Delivered";
			statusMessage = "Delivered";
		} else if (/^Delivery update:/i.test(subject)) {
			status = "InTransit";
			statusMessage = "Delayed";
		} else if (/^Shipped:/i.test(subject)) {
			status = "InTransit";
			statusMessage = "Shipped";
		} else if (/^Ordered:/i.test(subject)) {
			status = "Pending";
			statusMessage = "Ordered";
		}

		// Parse delivery date from text. "Arriving Thursday" etc. appears after
		// the progress bar (Ordered/Shipped/Out for delivery/Delivered).
		// Scan all lines and match the first "Arriving ..." line.
		let expectedDelivery = null;

		const lines = text.split("\n").map((l) => l.trim());
		for (const line of lines) {
			// "Arriving Thursday", "Now arriving Monday" (delay updates)
			const arrivingMatch = line.match(/^(?:Now\s+)?[Aa]rriving\s+(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i);
			if (arrivingMatch) {
				expectedDelivery = this.resolveRelativeDay(arrivingMatch[1], emailDate);
				break;
			}

			// "Arriving June 18"
			const arrivingDateMatch = line.match(/^(?:Now\s+)?[Aa]rriving\s+(\w+\s+\d{1,2})/i);
			if (arrivingDateMatch) {
				expectedDelivery = this.parseNaturalDate(arrivingDateMatch[1], emailDate);
				break;
			}
		}

		// For delivered emails with "Delivered today"
		if (status === "Delivered" && emailDate) {
			expectedDelivery = this.formatDateISO(emailDate);
		}

		// Check for "out for delivery" in body (Amazon sometimes sends this as an update)
		if (status === "InTransit") {
			for (const line of lines) {
				if (/^Arriving today$/i.test(line)) {
					status = "OutForDelivery";
					statusMessage = "Arriving today";
					if (emailDate) expectedDelivery = this.formatDateISO(emailDate);
					break;
				}
			}
		}

		// Merge into packages map
		const existing = this.packages.get(pkgKey);
		if (existing) {
			if (!emailDate || !existing.lastUpdate || emailDate > new Date(existing.lastUpdate)) {
				existing.status = status;
				existing.statusMessage = statusMessage;
				if (expectedDelivery) existing.expectedDelivery = expectedDelivery;
				if (itemName && !existing.nameSet) {
					existing.name = displayName;
					existing.nameSet = true;
				}
				existing.lastUpdate = emailDate?.toISOString() || null;
				if (status === "Delivered") {
					existing.deliveredAt = emailDate?.toISOString() || null;
				}
			}
		} else {
			this.packages.set(pkgKey, {
				id: pkgKey,
				carrier: "amazon",
				carrierName: "Amazon",
				name: displayName,
				nameSet: !!itemName,
				status,
				statusMessage,
				expectedDelivery,
				lastUpdate: emailDate?.toISOString() || null,
				deliveredAt: status === "Delivered" ? emailDate?.toISOString() : null,
				source: "gmail"
			});
		}
	},

	// --- Chewy Email Processing ---

	processChewyEmail (email) {
		const subject = email.subject || "";
		const text = email.text || "";
		const html = email.html || "";
		const emailDate = email.date;

		const orderMatch = text.match(/order\s*#?\s*(\d{9,})/i) || html.match(/order\s*#?\s*(\d{9,})/i);
		const orderId = orderMatch ? orderMatch[1] : null;

		const from = (email.from || "").toLowerCase();
		const trackingNumbers = this.extractTrackingNumbers(from, text, html);

		for (const m of html.matchAll(/(?:tracking_number|trackingId|tracking=|fedex\.com[^"']*?trackingnumber=)(\d{12,22})/gi)) {
			const num = m[1];
			if (!trackingNumbers.some((t) => t.number === num)) {
				trackingNumbers.push({ number: num, carrier: "fedex", carrierName: "FedEx" });
			}
		}

		let status = "InTransit";
		let statusMessage = "Shipped";
		const subjectLower = subject.toLowerCase();
		const textLower = text.toLowerCase();
		if (/\b(?:delivered|arrived)\b/.test(subjectLower) || /(?:has been|was|just)\s+delivered|package was delivered/.test(textLower)) {
			status = "Delivered";
			statusMessage = "Delivered";
		} else if (/out for delivery/.test(subjectLower)) {
			status = "OutForDelivery";
			statusMessage = "Out for delivery";
		} else if (/ship/.test(subjectLower)) {
			status = "InTransit";
			statusMessage = "Shipped";
		}

		let expectedDelivery = null;
		const dateMatch = text.match(/(?:estimated delivery|arriving|delivery by|expected.*?delivery)[:\s]*(\w+,?\s+\w+\s+\d{1,2})/i);
		if (dateMatch) {
			const cleaned = dateMatch[1].replace(/^\w+,\s*/, "");
			expectedDelivery = this.parseNaturalDate(cleaned, emailDate);
		}
		if (!expectedDelivery) {
			const relMatch = text.match(/(?:arriving|delivery by)\s+(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i);
			if (relMatch) {
				expectedDelivery = this.resolveRelativeDay(relMatch[1], emailDate);
			}
		}
		if (status === "Delivered" && emailDate && !expectedDelivery) {
			expectedDelivery = this.formatDateISO(emailDate);
		}

		let displayName = "Chewy Order";
		if (orderId) displayName = `Chewy Order #${orderId.slice(-6)}`;
		const itemMatch = subject.match(/your\s+(.+?)\s+(?:has shipped|order|is on)/i);
		if (itemMatch) displayName = itemMatch[1];

		const pkgKey = trackingNumbers.length > 0 ? trackingNumbers[0].number : (orderId ? `chewy-${orderId}` : null);
		if (!pkgKey) return;

		const carrier = trackingNumbers.length > 0 ? trackingNumbers[0].carrier : "chewy";
		const carrierName = trackingNumbers.length > 0 ? trackingNumbers[0].carrierName : "Chewy";

		const existing = this.packages.get(pkgKey);
		if (existing) {
			if (!emailDate || !existing.lastUpdate || emailDate > new Date(existing.lastUpdate)) {
				existing.status = status;
				existing.statusMessage = statusMessage;
				if (expectedDelivery) existing.expectedDelivery = expectedDelivery;
				existing.lastUpdate = emailDate?.toISOString() || null;
				if (status === "Delivered") existing.deliveredAt = emailDate?.toISOString() || null;
			}
		} else {
			this.packages.set(pkgKey, {
				id: pkgKey,
				carrier,
				carrierName,
				name: displayName,
				status,
				statusMessage,
				expectedDelivery,
				lastUpdate: emailDate?.toISOString() || null,
				deliveredAt: status === "Delivered" ? emailDate?.toISOString() : null,
				source: "gmail"
			});
		}
	},

	// --- Mana Pool Email Processing ---

	processManaPoolEmail (email) {
		const subject = email.subject || "";
		const text = email.text || "";
		const emailDate = email.date;

		// Skip non-shipping emails (magic links, welcome, marketing)
		if (!/shipped|order confirmation/i.test(subject)) return;

		// Order #310886-1123692 from subject
		const orderMatch = subject.match(/Order\s*#(\d[\d-]+)/i);
		if (!orderMatch) return;
		const orderId = orderMatch[1];
		const pkgKey = `manapool-${orderId}`;

		// First card name from the body
		const cardMatch = text.match(/Cards(.+?)(?:View order|If you have)/s);
		let displayName = `Mana Pool #${orderId.slice(-7)}`;
		if (cardMatch) {
			const cardLine = cardMatch[1].match(/([A-Z][A-Za-z' ,/]+)/);
			if (cardLine) displayName = cardLine[1].trim();
		}

		// Carrier from body text
		const carrierMatch = text.match(/Carrier:\s*(\w+)/i);
		const carrierName = carrierMatch ? carrierMatch[1] : "USPS";

		let status = "InTransit";
		let statusMessage = "Shipped";
		if (/order confirmation/i.test(subject)) {
			status = "Pending";
			statusMessage = "Ordered";
		}

		// Estimate delivery: USPS typically 3-7 days from ship date
		let expectedDelivery = null;
		if (emailDate && status === "InTransit") {
			const est = new Date(emailDate);
			est.setDate(est.getDate() + 5);
			expectedDelivery = this.formatDateISO(est);
		}

		const existing = this.packages.get(pkgKey);
		if (existing) {
			if (!emailDate || !existing.lastUpdate || emailDate > new Date(existing.lastUpdate)) {
				existing.status = status;
				existing.statusMessage = statusMessage;
				if (expectedDelivery) existing.expectedDelivery = expectedDelivery;
				existing.lastUpdate = emailDate?.toISOString() || null;
			}
		} else {
			this.packages.set(pkgKey, {
				id: pkgKey,
				carrier: carrierName.toLowerCase(),
				carrierName,
				name: displayName,
				status,
				statusMessage,
				expectedDelivery,
				lastUpdate: emailDate?.toISOString() || null,
				deliveredAt: null,
				source: "gmail"
			});
		}
	},

	// --- TCGPlayer Email Processing ---

	processTCGPlayerEmail (email) {
		const subject = email.subject || "";
		const html = email.html || "";
		const emailDate = email.date;

		// Only process shipped emails
		if (!/has shipped/i.test(subject)) return;

		// Order number from HTML: BFDCDD49-735F15-8B09E
		const orderMatch = html.match(/SearchString=([A-Z0-9-]+)/i)
			|| html.match(/Order\s*Number[:\s]*([A-Z0-9-]+)/i);
		if (!orderMatch) return;
		const orderId = orderMatch[1];
		const pkgKey = `tcg-${orderId}`;

		// Item name from subject: "Your TCGplayer.com order of [Card] and N more items has shipped."
		let displayName = `TCGPlayer #${orderId.slice(-5)}`;
		const itemMatch = subject.match(/order of\s+(.+?)\s+has shipped/i);
		if (itemMatch) {
			displayName = itemMatch[1]
				.replace(/\s+and\s+\d+\s+more\s+items?/i, (m) => ` +${m.match(/\d+/)[0]} more`)
				.trim();
		}

		// TCGPlayer ships without tracking — 7-10 business days
		let expectedDelivery = null;
		if (emailDate) {
			const est = new Date(emailDate);
			est.setDate(est.getDate() + 8);
			expectedDelivery = this.formatDateISO(est);
		}

		const existing = this.packages.get(pkgKey);
		if (existing) {
			if (!emailDate || !existing.lastUpdate || emailDate > new Date(existing.lastUpdate)) {
				if (expectedDelivery) existing.expectedDelivery = expectedDelivery;
				existing.lastUpdate = emailDate?.toISOString() || null;
			}
		} else {
			this.packages.set(pkgKey, {
				id: pkgKey,
				carrier: "tcgplayer",
				carrierName: "TCGPlayer",
				name: displayName,
				status: "InTransit",
				statusMessage: "Shipped",
				expectedDelivery,
				lastUpdate: emailDate?.toISOString() || null,
				deliveredAt: null,
				source: "gmail"
			});
		}
	},

	// --- Carrier Email Processing (UPS, FedEx, USPS, DHL) ---

	processCarrierEmail (email) {
		const from = (email.from || "").toLowerCase();
		const subject = email.subject || "";
		const text = email.text || "";
		const html = email.html || "";
		const emailDate = email.date;

		const trackingNumbers = this.extractTrackingNumbers(from, text, html);
		if (trackingNumbers.length === 0) return;

		// Determine status from subject/body
		const combined = `${subject} ${text}`.toLowerCase();
		let status = "InTransit";
		let statusMessage = "Shipped";
		if (/delivered|has been delivered|was delivered/.test(combined)) {
			status = "Delivered";
			statusMessage = "Delivered";
		} else if (/out for delivery/.test(combined)) {
			status = "OutForDelivery";
			statusMessage = "Out for delivery";
		} else if (/shipped|on its way|in transit/.test(combined)) {
			status = "InTransit";
			statusMessage = "In transit";
		} else if (/delay|exception|unable to deliver/.test(combined)) {
			status = "Exception";
			statusMessage = "Delivery exception";
		}

		// Try to extract delivery date
		let expectedDelivery = null;
		const dateMatch = text.match(/(?:expected|estimated|scheduled)\s+delivery[:\s]*(\w+,?\s+\w+\s+\d{1,2})/i)
			|| text.match(/(?:arriving|delivery by)\s+(\w+,?\s+\w+\s+\d{1,2})/i);
		if (dateMatch) {
			const cleaned = dateMatch[1].replace(/^\w+,\s*/, "");
			expectedDelivery = this.parseNaturalDate(cleaned, emailDate);
		}

		const itemName = this.nameFromSubject(subject);

		for (const { number, carrier, carrierName } of trackingNumbers) {
			const existing = this.packages.get(number);
			if (existing) {
				if (!emailDate || !existing.lastUpdate || emailDate > new Date(existing.lastUpdate)) {
					existing.status = status;
					existing.statusMessage = statusMessage;
					if (expectedDelivery) existing.expectedDelivery = expectedDelivery;
					existing.lastUpdate = emailDate?.toISOString() || null;
					if (status === "Delivered") existing.deliveredAt = emailDate?.toISOString() || null;
				}
			} else {
				this.packages.set(number, {
					id: number,
					carrier,
					carrierName,
					name: itemName || `${carrierName} ...${number.slice(-6)}`,
					status,
					statusMessage,
					expectedDelivery,
					lastUpdate: emailDate?.toISOString() || null,
					deliveredAt: status === "Delivered" ? emailDate?.toISOString() : null,
					source: "gmail"
				});
			}
		}
	},

	extractTrackingNumbers (from, text, html) {
		const results = [];
		const seen = new Set();
		const add = (number, carrier, carrierName) => {
			if (seen.has(number)) return;
			seen.add(number);
			results.push({ number, carrier, carrierName });
		};

		// UPS 1Z - very distinctive
		for (const m of text.matchAll(/\b(1Z[A-Z0-9]{16})\b/gi)) {
			add(m[1].toUpperCase(), "ups", "UPS");
		}

		// USPS 20+ digit starting with 9
		for (const m of text.matchAll(/\b(9[2-5]\d{19,21})\b/g)) {
			add(m[1], "usps", "USPS");
		}

		// FedEx - only from FedEx emails, near "tracking" context
		if (from.includes("fedex")) {
			const trackMatch = text.match(/tracking\s*(?:number|#|:)\s*(\d{12,15})/i);
			if (trackMatch) add(trackMatch[1], "fedex", "FedEx");
		}

		// DHL - only from DHL emails
		if (from.includes("dhl")) {
			const trackMatch = text.match(/tracking\s*(?:number|#|:)\s*(\d{10,11})/i);
			if (trackMatch) add(trackMatch[1], "dhl", "DHL");
		}

		// Tracking URLs in HTML
		for (const m of html.matchAll(/ups\.com[^"']*?(?:trackNums|InquiryNumber|tracknum)=([A-Z0-9]+)/gi)) {
			add(m[1].toUpperCase(), "ups", "UPS");
		}
		for (const m of html.matchAll(/fedex\.com[^"']*?(?:tracknumbers|trackingnumber)=(\d+)/gi)) {
			add(m[1], "fedex", "FedEx");
		}
		for (const m of html.matchAll(/tools\.usps\.com[^"']*?tLabels=(\d+)/gi)) {
			add(m[1], "usps", "USPS");
		}

		return results;
	},

	// --- Date Helpers ---

	resolveRelativeDay (dayStr, referenceDate) {
		const ref = referenceDate || new Date();
		const lower = dayStr.toLowerCase();

		if (lower === "today") return this.formatDateISO(ref);
		if (lower === "tomorrow") {
			const d = new Date(ref);
			d.setDate(d.getDate() + 1);
			return this.formatDateISO(d);
		}

		const targetDay = DAY_NAMES.indexOf(lower);
		if (targetDay === -1) return null;

		const currentDay = ref.getDay();
		let daysAhead = (targetDay - currentDay + 7) % 7;
		if (daysAhead === 0) daysAhead = 7;

		const d = new Date(ref);
		d.setDate(d.getDate() + daysAhead);
		return this.formatDateISO(d);
	},

	parseNaturalDate (str, referenceDate) {
		if (!str) return null;
		const ref = referenceDate || new Date();
		const cleaned = str.replace(",", "").trim();
		const months = {
			jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
			jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
			january: 0, february: 1, march: 2, april: 3, june: 5,
			july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
		};

		const parts = cleaned.split(/\s+/);
		if (parts.length >= 2) {
			const monthStr = parts[0].toLowerCase();
			const day = parseInt(parts[1]);
			const year = parts[2] ? parseInt(parts[2]) : ref.getFullYear();
			if (months[monthStr] !== undefined && day) {
				return this.formatDateISO(new Date(year, months[monthStr], day));
			}
		}
		return null;
	},

	formatDateISO (d) {
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	},

	nameFromSubject (subject) {
		if (!subject) return null;
		const cleaned = subject
			.replace(/^(re|fwd?|fw):\s*/gi, "")
			.replace(/your\s+(amazon\.com\s+)?order\s+(of\s+)?/i, "")
			.replace(/has\s+shipped.*$/i, "")
			.replace(/shipment\s+(confirmation|notification).*$/i, "")
			.replace(/delivery\s+notification.*$/i, "")
			.replace(/tracking\s+(number|update).*$/i, "")
			.replace(/^\s*[-–—:]\s*/, "")
			.trim();
		return cleaned.length > 3 && cleaned.length < 60 ? cleaned : null;
	},

	stripHtml (html) {
		return html
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
			.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/gi, " ")
			.replace(/&#\d+;/g, " ")
			.replace(/&\w+;/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}
});
