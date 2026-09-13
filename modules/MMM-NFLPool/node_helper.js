const NodeHelper = require("node_helper");
const Log = require("logger");
const fs = require("fs");
const path = require("path");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const DIVISIONS = ["NFCEast", "NFCNorth", "NFCSouth", "NFCWest", "AFCEast", "AFCNorth", "AFCSouth", "AFCWest"];

const MAX_FAIL_RETRIES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// The sender typically sends the weekly pool email early Sunday afternoon -
// start checking right at that expected time instead of on the same slow
// cadence used the rest of the week.
const SUNDAY_CHECK_HOUR = 11;
const SUNDAY_CHECK_MINUTE = 30;
const SUNDAY_POLL_INTERVAL_MS = 60 * 1000;

const WORD_NUMBERS = {
	one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
	ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
	sixteen: 16, seventeen: 17, eighteen: 18
};

const POOL_SCHEMA = {
	type: "OBJECT",
	required: ["weekLabel", "divisions", "games"],
	properties: {
		weekLabel: {
			type: "STRING",
			description: "The week or round label visible in the image if shown (e.g. 'Week 13', 'Wild Card'); empty string if not visible in the image."
		},
		divisions: {
			type: "ARRAY",
			items: {
				type: "OBJECT",
				required: ["name", "rows"],
				properties: {
					name: { type: "STRING", enum: DIVISIONS },
					rows: {
						type: "ARRAY",
						items: {
							type: "OBJECT",
							required: ["seed", "name", "total", "diff", "r3", "r3Diff", "pick1", "pick2"],
							properties: {
								seed: { type: "STRING" },
								name: { type: "STRING" },
								total: { type: "INTEGER" },
								diff: { type: "INTEGER" },
								r3: { type: "INTEGER" },
								r3Diff: { type: "INTEGER" },
								pick1: { type: "STRING" },
								pick2: { type: "STRING" }
							}
						}
					}
				}
			}
		},
		games: {
			type: "ARRAY",
			description: "Every game in the second table (the per-game points table), in any order.",
			items: {
				type: "OBJECT",
				required: ["awayTeam", "awayGain", "awayLoss", "homeTeam", "homeGain", "homeLoss"],
				properties: {
					awayTeam: { type: "STRING" },
					awayGain: { type: "INTEGER" },
					awayLoss: { type: "INTEGER" },
					homeTeam: { type: "STRING" },
					homeGain: { type: "INTEGER" },
					homeLoss: { type: "INTEGER" }
				}
			}
		}
	}
};

const SYSTEM_PROMPT = "You are a meticulous data-entry assistant. You will be shown a screenshot of a spreadsheet used for a weekly NFL confidence pool among friends. Extract every row from the image exactly as shown, matching the required JSON schema exactly. Do not summarize, skip, merge, or invent rows - extract all of them, including any that look unusual.";

const USER_PROMPT = [
	"This image has 8 sections, one per NFL division: NFCEast, NFCNorth, NFCSouth, NFCWest, AFCEast, AFCNorth, AFCSouth, AFCWest. Each section has a header row followed by several player rows. Each player row has these columns, in order: a seed/label cell (often blank, or a short code like \"D\", \"WC\", \".\", \"BL\", \"1.R3\", \"1*\"), the player's name, a TOTAL number, a Diff number, an R3 number, a second Diff number (for R3), and two Pick columns naming an NFL team (or \"-bye-\" if the player has no pick that week).",
	"",
	"Numeric cells (TOTAL, Diff, R3, R3 Diff) are sometimes shown in red text with the number in parentheses, e.g. \"(16)\" - this means -16 (negative), not literally 16. A plain black number like \"91\" means positive 91. Convert every numeric cell to a signed integer: strip parentheses and make it negative when parentheses/red styling is used, otherwise positive. If a numeric cell is blank or shows only a dash, output 0.",
	"",
	"For the seed cell, transcribe exactly what is shown, or an empty string if the cell is blank - do not guess or normalize the code.",
	"",
	"For the two Pick columns, transcribe the team name exactly as written (or \"-bye-\" literally if that's what's shown).",
	"",
	"Extract every row in every one of the 8 division sections - do not omit any player, and do not merge or reorder rows. If the image shows a week or round label (e.g. \"Week 13\" or \"Wild Card\"), put it in weekLabel; otherwise leave weekLabel as an empty string.",
	"",
	"Below the standings table there is a second table listing every NFL game for the week, grouped under day/time section headers like \"THURSDAY NIGHT\", \"SUNDAY EARLY\", \"SUNDAY LATE\", \"SUNDAY NIGHT\", \"MONDAY NIGHT\". Each game shows an away team, then \"at\", then a home team. Each team has two small numbers next to its name: the first is the number of points GAINED if that team is picked and wins, the second is a negative number of points LOST if picked and it loses. Each team also has a separate larger bold number and sometimes a small star - ignore both of those, they are not needed. Extract every game into the games array as awayTeam/awayGain/awayLoss/homeTeam/homeGain/homeLoss, using the exact team name spelling shown (it should match the same spelling used for that team in the Pick columns above)."
].join("\n");

module.exports = NodeHelper.create({
	start () {
		Log.log(`Starting node helper for: ${this.name}`);
		this.tokens = null;
		this.cache = this.loadCache();
		this.routesRegistered = false;
		this.scanTimer = null;
		this.retryStatus = null;
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "INIT_POOL") {
			this.init(payload);
		} else if (notification === "FETCH_POOL") {
			this.sendPoolData();
		}
	},

	async init (config) {
		this.config = config;

		if (config.gmail?.clientId && !this.routesRegistered) {
			this.registerRoutes(config);
			this.routesRegistered = true;
		}

		if (config.gmail?.clientId) {
			this.tokens = this.loadTokens();
			if (this.tokens) {
				this.sendSocketNotification("GMAIL_STATUS", { connected: true });
				await this.scanGmail();
				this.scheduleScan();
				await this.recomputeProjections();
			} else {
				this.sendSocketNotification("GMAIL_STATUS", { connected: false });
			}
		}

		this.sendPoolData();
	},

	scheduleScan () {
		if (this.scanTimer) clearTimeout(this.scanTimer);
		this.scanTimer = setTimeout(async () => {
			await this.scanGmail();
			this.sendPoolData();
			this.scheduleScan();
		}, this.getScanDelay());
	},

	// The pool email usually lands early Sunday afternoon - once past the
	// expected time with no email received yet that week, poll every minute
	// instead of waiting for the next slow, regular-interval tick to happen
	// to land in that window. Otherwise, use the normal interval, but never
	// sleep past the upcoming Sunday cutoff itself (so the first check after
	// it doesn't happen late).
	getScanDelay () {
		const normalInterval = this.config?.emailScanInterval || 4 * 60 * 60 * 1000;
		const now = new Date();
		const cutoff = this.mostRecentSundayCutoff(now);
		const hasThisWeeksEmail = !!this.cache.lastParsedAt && new Date(this.cache.lastParsedAt) >= cutoff;

		if (now >= cutoff && !hasThisWeeksEmail) {
			return SUNDAY_POLL_INTERVAL_MS;
		}

		const nextCutoff = new Date(cutoff);
		nextCutoff.setDate(nextCutoff.getDate() + 7);
		return Math.min(normalInterval, nextCutoff - now);
	},

	// The most recent Sunday 11:30am that isn't in the future.
	mostRecentSundayCutoff (now) {
		const cutoff = new Date(now);
		cutoff.setDate(cutoff.getDate() - cutoff.getDay());
		cutoff.setHours(SUNDAY_CHECK_HOUR, SUNDAY_CHECK_MINUTE, 0, 0);
		if (cutoff > now) {
			cutoff.setDate(cutoff.getDate() - 7);
		}
		return cutoff;
	},

	sendPoolData () {
		const cache = this.cache;
		this.sendSocketNotification("POOL_DATA", {
			weekLabel: cache.weekLabel,
			week: cache.week,
			divisions: cache.data?.divisions || [],
			homeDivisionName: cache.data?.homeDivisionName || null,
			rank: cache.data?.rank ?? null,
			ofCount: cache.data?.ofCount ?? null,
			parsedAt: cache.lastParsedAt,
			sourceSubject: cache.lastProcessedSubject,
			lastError: cache.lastError,
			lastErrorAt: cache.lastErrorAt,
			retryStatus: this.retryStatus || null
		});
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
					<div style="text-align:center"><h1>Gmail Connected</h1><p>You can close this tab. The mirror will start scanning for the pool standings email.</p></div>
				</body></html>`);

				await this.scanGmail();
				this.sendPoolData();
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

	// --- Cache (last-parsed week + failure tracking) ---

	getCachePath () {
		return path.join(this.path, "pool_cache.json");
	},

	loadCache () {
		try {
			return JSON.parse(fs.readFileSync(this.getCachePath(), "utf8"));
		} catch {
			return {
				lastProcessedMessageId: null,
				lastProcessedSubject: null,
				week: null,
				weekLabel: null,
				lastParsedAt: null,
				data: null,
				lastError: null,
				lastErrorAt: null,
				lastFailedMessageId: null,
				failCount: 0
			};
		}
	},

	saveCache () {
		fs.writeFileSync(this.getCachePath(), JSON.stringify(this.cache, null, 2));
	},

	// --- Gmail Scanning ---

	async scanGmail () {
		try {
			const accessToken = await this.getAccessToken();
			if (!accessToken) return;

			const senderEmail = this.config.senderEmail || "bcimorelli@gmail.com";
			// The subject wording isn't stable season to season - it used to
			// always include "Preview" (e.g. "Picks and Preview"), but this
			// season's actual weekly email is just "Week One Picks" with no
			// "Preview" at all, which the old subject:preview filter missed
			// entirely. "picks" alone is too broad though - this sender also
			// sends an unrelated midweek "NFL Pool - Weds picks" email - so
			// that's filtered out below by requiring the message to have
			// actually been sent on a Sunday, which reliably distinguishes the
			// real weekly email regardless of whatever it's titled that week.
			// newer_than guards against ever matching a stale email left over
			// from a prior season if this season hasn't sent one yet.
			const query = `from:${senderEmail} subject:"NFL Pool" subject:picks newer_than:14d`;
			const listResp = await fetch(`${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=10`, {
				headers: { Authorization: `Bearer ${accessToken}` }
			});
			if (!listResp.ok) {
				Log.error(`${this.name}: Gmail search failed: ${listResp.status}`);
				return;
			}
			const listData = await listResp.json();
			const messages = listData.messages || [];
			if (messages.length === 0) return;

			const metas = [];
			for (const msg of messages) {
				const meta = await this.fetchMessageMeta(accessToken, msg.id);
				if (meta && meta.date && meta.date.getDay() === 0) metas.push(meta);
			}
			metas.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
			if (metas.length === 0) return;

			const newest = metas[0];
			if (newest.id === this.cache.lastProcessedMessageId) return;
			if (newest.id === this.cache.lastFailedMessageId && this.cache.failCount >= MAX_FAIL_RETRIES) return;

			for (const meta of metas) {
				if (meta.id === this.cache.lastProcessedMessageId) break;

				const full = await this.fetchFullMessage(accessToken, meta.id);
				if (!full) continue;

				const imagePart = this.findLargestImageAttachment(full.payload);
				if (!imagePart) continue;

				await this.processEmailImage(accessToken, meta, imagePart, full.payload);
				return;
			}
		} catch (error) {
			Log.error(`${this.name}: Gmail scan error:`, error.message);
		}
	},

	async fetchMessageMeta (accessToken, messageId) {
		try {
			const resp = await fetch(`${GMAIL_API}/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date`, {
				headers: { Authorization: `Bearer ${accessToken}` }
			});
			if (!resp.ok) return null;
			const data = await resp.json();
			const headers = data.payload?.headers || [];
			const getHeader = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
			const dateStr = getHeader("Date");
			return {
				id: messageId,
				subject: getHeader("Subject"),
				date: dateStr ? new Date(dateStr) : null
			};
		} catch {
			return null;
		}
	},

	async fetchFullMessage (accessToken, messageId) {
		try {
			const resp = await fetch(`${GMAIL_API}/messages/${messageId}?format=full`, {
				headers: { Authorization: `Bearer ${accessToken}` }
			});
			if (!resp.ok) return null;
			return await resp.json();
		} catch {
			return null;
		}
	},

	findLargestImageAttachment (payload) {
		if (!payload) return null;
		let best = null;
		const visit = (part) => {
			if (!part) return;
			if (part.mimeType?.startsWith("image/") && part.body?.attachmentId) {
				if (!best || (part.body.size || 0) > (best.body.size || 0)) best = part;
			}
			if (part.parts) {
				for (const child of part.parts) visit(child);
			}
		};
		visit(payload);
		return best;
	},

	async fetchAttachmentData (accessToken, messageId, attachmentId) {
		const resp = await fetch(`${GMAIL_API}/messages/${messageId}/attachments/${attachmentId}`, {
			headers: { Authorization: `Bearer ${accessToken}` }
		});
		if (!resp.ok) throw new Error(`Failed to fetch attachment: ${resp.status}`);
		const data = await resp.json();
		return Buffer.from(data.data, "base64url");
	},

	// --- Email Processing ---

	// The per-game points table is also always present as plain, reliably
	// structured text in the email body itself (confirmed across many weeks'
	// worth of real emails) - unlike asking vision to read it off the
	// screenshot, which can and does just come back empty. Text parsing is
	// the primary source; vision's own games array (if any) is only a
	// fallback for whenever this format itself changes.
	findHtmlParts (payload) {
		const results = [];
		const visit = (part) => {
			if (!part) return;
			if (part.mimeType?.startsWith("text/html")) results.push(part);
			if (part.parts) for (const child of part.parts) visit(child);
		};
		visit(payload);
		return results;
	},

	stripHtmlToText (html) {
		return html
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/\s+/g, " ")
			.trim();
	},

	parseGamesFromEmailPayload (payload) {
		const htmlParts = this.findHtmlParts(payload);
		if (htmlParts.length === 0) return [];
		const html = htmlParts.map((p) => Buffer.from(p.body?.data || "", "base64url").toString("utf8")).join("\n");
		const text = this.stripHtmlToText(html);

		// Split into per-section chunks first so each game can be tagged with
		// which day/time it's under - a Thursday (or any pre-Sunday) game is
		// already over by the time the Sunday email goes out, so the
		// spreadsheet's own Total already includes it; a Sunday/Monday game
		// is still ahead of us and needs tracking live. Without this tag,
		// computeProjections would double-count an already-finished
		// Thursday game once our own live tracking also picks it up.
		// Match any day name here, not a hardcoded subset - the sender has used
		// an unlisted "WEDNESDAY NIGHT" section before (e.g. a season-opener
		// game), and a hardcoded list silently drops that section's games
		// entirely instead of just mis-tagging them.
		const sectionRegex = /(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)\s+(NIGHT|EARLY|LATE|AFTERNOON|MORNING)/g;
		const sections = [];
		let lastIndex = 0;
		let lastSectionDay = null;
		let sectionMatch;
		while ((sectionMatch = sectionRegex.exec(text))) {
			if (lastSectionDay !== null) {
				sections.push({ day: lastSectionDay, text: text.slice(lastIndex, sectionMatch.index) });
			}
			lastSectionDay = sectionMatch[1];
			lastIndex = sectionMatch.index + sectionMatch[0].length;
		}
		if (lastSectionDay !== null) {
			sections.push({ day: lastSectionDay, text: text.slice(lastIndex) });
		}

		// e.g. "49ers 3 -2 0 at Rams 2 -3 0" - team name, gain, loss, then a
		// separate bold/starred number that isn't needed, "at", then the same
		// for the home team.
		const gameRegex = /(\S+)\s+(\d+)\s+(-\d+)\s+\d+\*{0,2}\s+at\s+(\S+)\s+(\d+)\s+(-\d+)\s+\d+\*{0,2}/g;
		const games = [];
		for (const { day, text: sectionText } of sections) {
			const isPreSunday = day !== "SUNDAY" && day !== "MONDAY";
			gameRegex.lastIndex = 0;
			let match;
			while ((match = gameRegex.exec(sectionText))) {
				games.push({
					awayTeam: match[1],
					awayGain: parseInt(match[2], 10),
					awayLoss: parseInt(match[3], 10),
					homeTeam: match[4],
					homeGain: parseInt(match[5], 10),
					homeLoss: parseInt(match[6], 10),
					isPreSunday
				});
			}
		}
		return games;
	},

	async processEmailImage (accessToken, meta, imagePart, emailPayload) {
		try {
			if (!this.config.geminiKey) {
				throw new Error("Gemini API key not configured");
			}

			const imageBuffer = await this.fetchAttachmentData(accessToken, meta.id, imagePart.body.attachmentId);
			if (imageBuffer.length > MAX_IMAGE_BYTES) {
				throw new Error(`Image attachment too large for Gemini vision (${Math.round(imageBuffer.length / 1024)}kb)`);
			}

			const mimeType = /^image\/(png|jpeg|gif|webp)$/.test(imagePart.mimeType) ? imagePart.mimeType : "image/png";
			const result = await this.callGeminiVisionWithRetry(imageBuffer, mimeType);

			const { weekLabel, week } = this.resolveWeek(meta.subject, result.weekLabel);
			const userName = this.config.userName || "Caden";
			const textGames = this.parseGamesFromEmailPayload(emailPayload);
			const games = textGames.length > 0 ? textGames : (result.games || []);
			const rawDivisions = this.annotateRows(result.divisions || [], userName);

			this.cache.lastProcessedMessageId = meta.id;
			this.cache.lastProcessedSubject = meta.subject;
			this.cache.week = week;
			this.cache.weekLabel = weekLabel;
			this.cache.lastParsedAt = new Date().toISOString();
			this.cache.data = { divisions: rawDivisions, games, homeDivisionName: null, rank: null, ofCount: null };
			this.cache.lastError = null;
			this.cache.lastErrorAt = null;
			this.cache.lastFailedMessageId = null;
			this.cache.failCount = 0;
			this.saveCache();

			await this.recomputeProjections();

			Log.info(`${this.name}: Parsed pool standings for ${weekLabel || meta.subject}`);
		} catch (error) {
			if (this.cache.lastFailedMessageId === meta.id) {
				this.cache.failCount = (this.cache.failCount || 0) + 1;
			} else {
				this.cache.lastFailedMessageId = meta.id;
				this.cache.failCount = 1;
			}
			this.cache.lastError = error.message;
			this.cache.lastErrorAt = new Date().toISOString();
			this.saveCache();
			Log.error(`${this.name}: Failed to parse pool email:`, error.message);
		}
	},

	// Quick retries for transient failures (e.g. Gemini's "high demand" 503s
	// seen in practice) so a blip that resolves within seconds doesn't have to
	// wait for the next 4-hour scheduled scan to try again. Exhausting these
	// still falls back to the slower per-scan retry counter in processEmailImage.
	async callGeminiVisionWithRetry (imageBuffer, mimeType) {
		const delaysMs = [5000, 15000];
		const totalAttempts = delaysMs.length + 1;
		let lastError;
		for (let attempt = 1; attempt <= totalAttempts; attempt++) {
			try {
				const result = await this.callGeminiVision(imageBuffer, mimeType);
				this.retryStatus = null;
				return result;
			} catch (error) {
				lastError = error;
				Log.warn(`${this.name}: Gemini attempt ${attempt}/${totalAttempts} failed: ${error.message}`);
				if (attempt < totalAttempts) {
					this.retryStatus = `Gemini error, retrying (attempt ${attempt + 1} of ${totalAttempts})…`;
					this.sendPoolData();
					await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt - 1]));
				}
			}
		}
		this.retryStatus = null;
		throw lastError;
	},

	async callGeminiVision (imageBuffer, mimeType) {
		const model = this.config.geminiModel || "gemini-3.6-flash";
		const response = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
			method: "POST",
			headers: {
				"x-goog-api-key": this.config.geminiKey,
				"content-type": "application/json"
			},
			body: JSON.stringify({
				systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
				contents: [
					{
						role: "user",
						parts: [
							{ inlineData: { mimeType, data: imageBuffer.toString("base64") } },
							{ text: USER_PROMPT }
						]
					}
				],
				generationConfig: {
					responseMimeType: "application/json",
					responseSchema: POOL_SCHEMA
				}
			})
		});

		const data = await response.json();
		if (!response.ok) {
			throw new Error(data.error?.message || `Gemini API error: ${response.status}`);
		}

		const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
		if (!text) throw new Error("Gemini returned no content");

		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error("Gemini returned invalid JSON");
		}

		if (!Array.isArray(parsed.divisions) || !Array.isArray(parsed.games)) {
			throw new Error("Gemini did not return valid pool standings data");
		}

		return parsed;
	},

	// --- Data Shaping ---

	resolveWeek (subject, imageWeekLabel) {
		const fromSubject = this.parseWeek(subject);
		if (fromSubject.week !== null) return fromSubject;

		const fromImage = this.parseWeek(imageWeekLabel);
		if (fromImage.week !== null) return fromImage;

		return { weekLabel: imageWeekLabel || subject || null, week: null };
	},

	parseWeek (text) {
		if (!text) return { weekLabel: null, week: null };
		const trimmed = text.trim();

		const digitMatch = trimmed.match(/week\s+(\d{1,2})/i);
		if (digitMatch) return { weekLabel: `Week ${digitMatch[1]}`, week: parseInt(digitMatch[1], 10) };

		const wordMatch = trimmed.match(/week\s+([a-z]+)/i);
		if (wordMatch) {
			const num = WORD_NUMBERS[wordMatch[1].toLowerCase()];
			if (num) return { weekLabel: `Week ${num}`, week: num };
		}

		return { weekLabel: trimmed, week: null };
	},

	annotateRows (divisions, userName) {
		const nameLower = userName.trim().toLowerCase();
		const isDoubleDown = (pick) => !!pick && pick !== "-bye-" && pick === pick.toUpperCase() && pick !== pick.toLowerCase();
		// The spreadsheet sometimes marks a player's name with a trailing
		// symbol (*, #, +, etc. - whatever this pool's own convention is for
		// it) - vision extraction faithfully includes it in the name text
		// itself, so it needs stripping here rather than showing up literally
		// on screen. Keeps letters/spaces/apostrophes/hyphens/periods (real
		// names can have all of those - "Mary-Jane O'Brien Jr."), strips
		// anything else - including a dangling trailing hyphen that's left
		// over once the symbol after it is gone (a real name never ends in a
		// bare "-", it's always between two words).
		const cleanName = (name) => (name || "").replace(/[^a-zA-Z\s'.-]/g, "").replace(/\s+/g, " ").trim().replace(/[\s-]+$/, "");
		return divisions.map((div) => ({
			name: div.name,
			rows: (div.rows || []).map((row) => ({
				seed: row.seed || "",
				name: cleanName(row.name),
				// rawTotal is exactly what the sender's sheet showed, and is
				// never itself reassigned - recomputeProjections overwrites
				// cache.data.divisions with computeProjections's own output
				// every cycle, so a mutated "total" field would keep getting
				// re-adjusted from an already-adjusted value on every
				// subsequent tick instead of the real original.
				rawTotal: row.total,
				total: row.total,
				totalClass: row.total < 0 ? "pool-negative" : "pool-positive",
				diff: row.diff,
				diffClass: row.diff < 0 ? "pool-negative" : "pool-positive",
				r3: row.r3,
				r3Diff: row.r3Diff,
				r3DiffClass: row.r3Diff < 0 ? "pool-negative" : "pool-positive",
				pick1Team: row.pick1 || "",
				pick2Team: row.pick2 || "",
				pick1DoubleDown: isDoubleDown(row.pick1),
				pick2DoubleDown: isDoubleDown(row.pick2),
				isUser: !!(row.name && row.name.toLowerCase().includes(nameLower))
			}))
		}));
	},

	// --- Live Scores & Projections ---

	async fetchLiveGames () {
		const key = this.config?.balldontlieKey;
		if (!key) return [];

		const dates = [];
		for (let offset = -4; offset <= 3; offset++) {
			const d = new Date();
			d.setDate(d.getDate() + offset);
			dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
		}

		const params = dates.map((d) => `dates[]=${d}`).join("&");
		const resp = await fetch(`https://api.balldontlie.io/nfl/v1/games?${params}`, {
			headers: { Authorization: key }
		});
		if (!resp.ok) {
			Log.error(`${this.name}: balldontlie games fetch failed: ${resp.status}`);
			return [];
		}

		const data = await resp.json();
		return (data.data || []).map((game) => ({
			awayTeam: game.visitor_team?.full_name || "",
			homeTeam: game.home_team?.full_name || "",
			awayScore: game.visitor_team_score,
			homeScore: game.home_team_score,
			state: game.status_state === "scheduled" ? "pre" : (game.status_state === "final" ? "post" : "in")
		}));
	},

	matchLiveGame (teamName, liveGames) {
		if (!teamName) return null;
		const lower = teamName.toLowerCase();
		return liveGames.find((g) => g.awayTeam.toLowerCase().includes(lower) || g.homeTeam.toLowerCase().includes(lower)) || null;
	},

	findGameEntry (teamName, games) {
		if (!teamName) return null;
		const lower = teamName.toLowerCase();
		for (const game of games) {
			if (game.awayTeam.toLowerCase() === lower) return { gain: game.awayGain, loss: game.awayLoss, isPreSunday: game.isPreSunday };
			if (game.homeTeam.toLowerCase() === lower) return { gain: game.homeGain, loss: game.homeLoss, isPreSunday: game.isPreSunday };
		}
		return null;
	},

	computePickOutcome (teamName, games, liveGames) {
		if (!teamName || teamName === "-bye-") return { swing: 0, status: "bye", gain: null, loss: null, isPreSunday: false };

		const entry = this.findGameEntry(teamName, games);
		if (!entry) return { swing: 0, status: "pending", gain: null, loss: null, isPreSunday: false };

		const live = this.matchLiveGame(teamName, liveGames);
		if (!live || live.state === "pre" || live.awayScore === null || live.homeScore === null) {
			return { swing: 0, status: "pending", gain: entry.gain, loss: entry.loss, isPreSunday: entry.isPreSunday };
		}

		if (live.awayScore === live.homeScore) return { swing: 0, status: "tied", gain: entry.gain, loss: entry.loss, isPreSunday: entry.isPreSunday };

		const teamLower = teamName.toLowerCase();
		const isAway = live.awayTeam.toLowerCase().includes(teamLower);
		const teamScore = isAway ? live.awayScore : live.homeScore;
		const oppScore = isAway ? live.homeScore : live.awayScore;
		const isLeading = teamScore > oppScore;
		const swing = isLeading ? entry.gain : entry.loss;
		const status = live.state === "post" ? (isLeading ? "won" : "lost") : (isLeading ? "winning" : "losing");

		return { swing, status, gain: entry.gain, loss: entry.loss, isPreSunday: entry.isPreSunday };
	},

	// Pending or still-live (winning/losing): show both possible outcomes,
	// not just whichever one currently applies - a live game can still
	// swing the other way before it's final. The one that ISN'T how the
	// game presently stands gets a dimming class rather than disappearing,
	// so it's clear it's not locked in yet. Decided (won/lost) or tied: show
	// just the one real, final value.
	formatPickPoints (outcome, multiplier) {
		if (outcome.status === "bye") return "";
		if (outcome.status === "tied") return "0";
		if (outcome.status === "won" || outcome.status === "lost") {
			const swing = outcome.swing * multiplier;
			return swing >= 0 ? `+${swing}` : `${swing}`;
		}
		if (outcome.gain === null) return "";
		const gainText = `+${outcome.gain * multiplier}`;
		const lossText = `${outcome.loss * multiplier}`;
		if (outcome.status === "winning") return `${gainText}/<span class="pool-pick-inactive">${lossText}</span>`;
		if (outcome.status === "losing") return `<span class="pool-pick-inactive">${gainText}</span>/${lossText}`;
		return `${gainText}/${lossText}`;
	},

	computeProjections (divisions, games, liveGames) {
		// total/projectedTotal only count swing from picks whose game has
		// actually finished ("won"/"lost"/"tied"), not ones still live
		// ("winning"/"losing"), so neither fluctuates on every scoring play
		// before a result is actually final. The individual pick display
		// (pickPoints1/2) still shows live status regardless.
		//
		// A pre-Sunday (e.g. Thursday night) pick that's already final is a
		// special case: the spreadsheet screenshot was taken (and the email
		// sent) AFTER that game already finished, so the sender's own Total
		// already bakes it in. "Tot" is meant to show points going into this
		// week, so that baked-in swing is backed back out of total here -
		// then it's added into projectedTotal the same as any other
		// completed game this week, alongside our own live tracking.
		const isFinalOutcome = (status) => status === "won" || status === "lost" || status === "tied";
		const projected = divisions.map((div) => ({
			...div,
			rows: div.rows
				.map((row) => {
					const outcome1 = this.computePickOutcome(row.pick1Team, games, liveGames);
					const outcome2 = this.computePickOutcome(row.pick2Team, games, liveGames);
					const mult1 = row.pick1DoubleDown ? 2 : 1;
					const mult2 = row.pick2DoubleDown ? 2 : 1;
					const swing1 = isFinalOutcome(outcome1.status) ? outcome1.swing * mult1 : 0;
					const swing2 = isFinalOutcome(outcome2.status) ? outcome2.swing * mult2 : 0;
					const bakedIn = (outcome1.isPreSunday ? swing1 : 0) + (outcome2.isPreSunday ? swing2 : 0);
					const total = row.rawTotal - bakedIn;
					const projectedTotal = total + swing1 + swing2;

					return {
						...row,
						total,
						totalClass: total < 0 ? "pool-negative" : "pool-positive",
						pick1Status: outcome1.status,
						pick2Status: outcome2.status,
						pickPoints1: this.formatPickPoints(outcome1, mult1),
						pickPoints2: this.formatPickPoints(outcome2, mult2),
						projectedTotal,
						projectedTotalClass: projectedTotal < 0 ? "pool-negative" : "pool-positive"
					};
				})
				.sort((a, b) => b.projectedTotal - a.projectedTotal)
		}));

		this.computeConferenceRanks(projected);
		this.markBiggestLosers(projected);

		// Vacuously true for an empty games list (e.g. a season-announcement
		// email with no games table yet) - nothing to poll for, so don't start
		// the live-score timer until a week with real games actually parses.
		const allGamesFinal = games.every((game) => {
			const live = this.matchLiveGame(game.awayTeam, liveGames) || this.matchLiveGame(game.homeTeam, liveGames);
			return live?.state === "post";
		});

		return { projected, allGamesFinal };
	},

	// This pool's own playoff format (not the real current NFL one): 4
	// division champs + 4 wildcards per conference, 8 total. A division
	// champ is guaranteed in regardless of their conference-wide rank (real
	// NFL rules work the same way - a weak division's winner still gets in
	// over a better non-champion elsewhere), so this finds each division's
	// own top scorer first ("D"), then fills the 4 wildcard spots ("WC")
	// from whoever's left in that conference, ranked by score. Everyone else
	// shows "+N", how many spots past the last wildcard spot they currently
	// are.
	computeConferenceRanks (divisions) {
		const WILDCARD_SPOTS = 4;
		const conferences = { NFC: [], AFC: [] };
		for (const div of divisions) {
			const conf = div.name.startsWith("NFC") ? "NFC" : "AFC";
			for (const row of div.rows) {
				conferences[conf].push({ row, division: div.name });
			}
		}

		for (const entries of Object.values(conferences)) {
			const byDivision = new Map();
			for (const entry of entries) {
				if (!byDivision.has(entry.division)) byDivision.set(entry.division, []);
				byDivision.get(entry.division).push(entry);
			}

			const champs = new Set();
			for (const group of byDivision.values()) {
				const champ = [...group].sort((a, b) => b.row.projectedTotal - a.row.projectedTotal)[0];
				if (champ) champs.add(champ.row);
			}

			const nonChamps = entries
				.map((entry) => entry.row)
				.filter((row) => !champs.has(row))
				.sort((a, b) => b.projectedTotal - a.projectedTotal);

			for (const row of champs) {
				row.seedDisplay = "D";
			}
			nonChamps.forEach((row, idx) => {
				row.seedDisplay = idx < WILDCARD_SPOTS ? "WC" : `+${idx - WILDCARD_SPOTS + 1}`;
			});
		}
	},

	// Pool-wide (both conferences, all 8 divisions together) - the bottom 5
	// scorers get "BL" ("Biggest Losers"), overriding whatever seed they'd
	// otherwise show (though in practice a team scoring this low was never
	// going to be a division champ or wildcard anyway).
	markBiggestLosers (divisions) {
		const BIGGEST_LOSERS_COUNT = 5;
		const allRows = divisions.flatMap((div) => div.rows);
		const losers = [...allRows].sort((a, b) => a.projectedTotal - b.projectedTotal).slice(0, BIGGEST_LOSERS_COUNT);
		for (const row of losers) {
			row.seedDisplay = "BL";
		}
	},

	// Idempotent: safe to call after a fresh parse, on process restart with
	// existing cached data, or from the recurring timer tick. Recomputes
	// projections from this.cache.data (divisions + games), then starts the
	// polling timer if any games are still undecided, or stops it once every
	// game is final.
	async recomputeProjections () {
		if (!this.cache.data?.divisions || !this.cache.data?.games) return;

		try {
			const liveGames = await this.fetchLiveGames();
			const { projected, allGamesFinal } = this.computeProjections(this.cache.data.divisions, this.cache.data.games, liveGames);
			const { homeDivisionName, rank, ofCount } = this.computeHomeStanding(projected);

			this.cache.data.divisions = projected;
			this.cache.data.homeDivisionName = homeDivisionName;
			this.cache.data.rank = rank;
			this.cache.data.ofCount = ofCount;
			this.saveCache();
			this.sendPoolData();

			if (allGamesFinal) {
				if (this.liveScoreTimer) clearInterval(this.liveScoreTimer);
				this.liveScoreTimer = null;
			} else if (!this.liveScoreTimer) {
				const interval = this.config?.liveScoreInterval || 2 * 60 * 1000;
				this.liveScoreTimer = setInterval(() => this.recomputeProjections(), interval);
			}
		} catch (error) {
			Log.error(`${this.name}: Live score refresh error:`, error.message);
		}
	},

	computeHomeStanding (divisions) {
		for (const div of divisions) {
			const idx = div.rows.findIndex((r) => r.isUser);
			if (idx === -1) continue;
			const sorted = [...div.rows].sort((a, b) => b.projectedTotal - a.projectedTotal);
			const rank = sorted.findIndex((r) => r.isUser) + 1;
			return { homeDivisionName: div.name, rank, ofCount: div.rows.length };
		}
		return { homeDivisionName: null, rank: null, ofCount: null };
	}
});
