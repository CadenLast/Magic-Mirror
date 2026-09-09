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
							required: ["seed", "name", "total", "diff", "r3", "r3Diff", "pick1", "pick1Extra", "pick2", "pick2Extra"],
							properties: {
								seed: { type: "STRING" },
								name: { type: "STRING" },
								total: { type: "INTEGER" },
								diff: { type: "INTEGER" },
								r3: { type: "INTEGER" },
								r3Diff: { type: "INTEGER" },
								pick1: { type: "STRING" },
								pick1Extra: { type: "STRING" },
								pick2: { type: "STRING" },
								pick2Extra: { type: "STRING" }
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
	"For the two Pick columns, transcribe the team name exactly as written (or \"-bye-\" literally if that's what's shown). Occasionally there is a small extra value in or immediately before a pick cell (e.g. a lone number like \"1\") - capture that in the matching pick1Extra/pick2Extra field as a string, and use an empty string when there is no such extra value.",
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
		if (this.scanTimer) clearInterval(this.scanTimer);
		const interval = this.config?.emailScanInterval || 4 * 60 * 60 * 1000;
		this.scanTimer = setInterval(async () => {
			await this.scanGmail();
			this.sendPoolData();
		}, interval);
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
			// newer_than guards against ever matching a stale "Picks and Preview"
			// email left over from a prior season if this season hasn't sent one
			// yet - confirmed live that this can otherwise happen.
			const query = `from:${senderEmail} subject:"NFL Pool" subject:preview newer_than:14d`;
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
				if (meta) metas.push(meta);
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

				await this.processEmailImage(accessToken, meta, imagePart);
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

	async processEmailImage (accessToken, meta, imagePart) {
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
			const games = result.games || [];
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
		const hasExtra = (extra) => {
			const trimmed = (extra || "").trim();
			return trimmed !== "" && trimmed !== "-";
		};
		const isDoubleDown = (pick) => !!pick && pick !== "-bye-" && pick === pick.toUpperCase() && pick !== pick.toLowerCase();
		return divisions.map((div) => ({
			name: div.name,
			rows: (div.rows || []).map((row) => ({
				seed: row.seed || "",
				name: row.name || "",
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
				pickDisplay1: hasExtra(row.pick1Extra) ? `${row.pick1Extra.trim()} ${row.pick1}` : (row.pick1 || ""),
				pickDisplay2: hasExtra(row.pick2Extra) ? `${row.pick2Extra.trim()} ${row.pick2}` : (row.pick2 || ""),
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
			if (game.awayTeam.toLowerCase() === lower) return { gain: game.awayGain, loss: game.awayLoss };
			if (game.homeTeam.toLowerCase() === lower) return { gain: game.homeGain, loss: game.homeLoss };
		}
		return null;
	},

	computePickOutcome (teamName, games, liveGames) {
		if (!teamName || teamName === "-bye-") return { swing: 0, status: "bye" };

		const entry = this.findGameEntry(teamName, games);
		if (!entry) return { swing: 0, status: "pending" };

		const live = this.matchLiveGame(teamName, liveGames);
		if (!live || live.state === "pre" || live.awayScore === null || live.homeScore === null) {
			return { swing: 0, status: "pending" };
		}

		if (live.awayScore === live.homeScore) return { swing: 0, status: "tied" };

		const teamLower = teamName.toLowerCase();
		const isAway = live.awayTeam.toLowerCase().includes(teamLower);
		const teamScore = isAway ? live.awayScore : live.homeScore;
		const oppScore = isAway ? live.homeScore : live.awayScore;
		const isLeading = teamScore > oppScore;
		const swing = isLeading ? entry.gain : entry.loss;
		const status = live.state === "post" ? (isLeading ? "won" : "lost") : (isLeading ? "winning" : "losing");

		return { swing, status };
	},

	computeProjections (divisions, games, liveGames) {
		const projected = divisions.map((div) => ({
			...div,
			rows: div.rows.map((row) => {
				const outcome1 = this.computePickOutcome(row.pick1Team, games, liveGames);
				const outcome2 = this.computePickOutcome(row.pick2Team, games, liveGames);
				const swing1 = row.pick1DoubleDown ? outcome1.swing * 2 : outcome1.swing;
				const swing2 = row.pick2DoubleDown ? outcome2.swing * 2 : outcome2.swing;
				const projectedTotal = row.total + swing1 + swing2;

				return {
					...row,
					pick1Status: outcome1.status,
					pick2Status: outcome2.status,
					projectedTotal,
					projectedTotalClass: projectedTotal < 0 ? "pool-negative" : "pool-positive"
				};
			})
		}));

		// Vacuously true for an empty games list (e.g. a season-announcement
		// email with no games table yet) - nothing to poll for, so don't start
		// the live-score timer until a week with real games actually parses.
		const allGamesFinal = games.every((game) => {
			const live = this.matchLiveGame(game.awayTeam, liveGames) || this.matchLiveGame(game.homeTeam, liveGames);
			return live?.state === "post";
		});

		return { projected, allGamesFinal };
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
