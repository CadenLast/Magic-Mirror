const NodeHelper = require("node_helper");
const Log = require("logger");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const DBUS_DEST = "org.gnome.ShairportSync";
const DBUS_PATH = "/org/mpris/MediaPlayer2";
const DBUS_IFACE = "org.mpris.MediaPlayer2.Player";
const NEW_RELEASES_CACHE_FILE = path.join(__dirname, "new_releases_cache.json");
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_NEW_RELEASES_URL = "https://api.spotify.com/v1/browse/new-releases";

module.exports = NodeHelper.create({
	start: function () {
		this.reading = false;
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "CONFIG" && !this.reading) {
			this.config = payload;
			this.reading = true;
			this.startReading();
			this.checkCurrentPlayback();
			this.loadNewReleases();
		}
	},

	shuffleArray: function (arr) {
		for (let i = arr.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[arr[i], arr[j]] = [arr[j], arr[i]];
		}
		return arr;
	},

	loadNewReleasesCache: function () {
		try {
			return JSON.parse(fs.readFileSync(NEW_RELEASES_CACHE_FILE, "utf8"));
		} catch (e) {
			return null;
		}
	},

	saveNewReleasesCache: function (tracks) {
		try {
			fs.writeFileSync(NEW_RELEASES_CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), tracks }));
		} catch (e) {
			// ignore
		}
	},

	loadNewReleases: async function () {
		if (!this.config.spotify || !this.config.spotify.clientId || !this.config.spotify.clientSecret) {
			return;
		}

		const cache = this.loadNewReleasesCache();
		const refreshMs = (this.config.newReleasesRefreshHours || 12) * 60 * 60 * 1000;
		const isFresh = cache && Date.now() - cache.fetchedAt < refreshMs;

		if (cache && cache.tracks.length > 0) {
			this.sendSocketNotification("RECENT_TRACKS", this.shuffleArray(cache.tracks.slice()));
		}

		if (isFresh) return;

		try {
			const tracks = await this.fetchNewReleases();
			if (tracks.length > 0) {
				this.saveNewReleasesCache(tracks);
				this.sendSocketNotification("RECENT_TRACKS", this.shuffleArray(tracks.slice()));
			}
		} catch (e) {
			const cause = e.cause ? ` (cause: ${e.cause.message || e.cause})` : "";
			Log.error(`${this.name}: failed to fetch Spotify new releases - ${e.message}${cause}`);
		}
	},

	getSpotifyToken: async function () {
		if (this.spotifyToken && Date.now() < this.spotifyToken.expiresAt) {
			return this.spotifyToken.value;
		}

		const { clientId, clientSecret } = this.config.spotify;
		const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

		const response = await fetch(SPOTIFY_TOKEN_URL, {
			method: "POST",
			headers: {
				Authorization: `Basic ${basicAuth}`,
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": "Mozilla/5.0 (compatible; MagicMirror-MusicDisplay/1.0)",
			},
			body: "grant_type=client_credentials",
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`token request failed with status ${response.status}: ${body}`);
		}

		const json = await response.json();
		this.spotifyToken = {
			value: json.access_token,
			expiresAt: Date.now() + (json.expires_in - 60) * 1000,
		};
		return this.spotifyToken.value;
	},

	fetchNewReleases: async function () {
		const token = await this.getSpotifyToken();
		const country = this.config.newReleasesCountry || "US";
		const limit = this.config.newReleasesLimit || 20;
		const url = `${SPOTIFY_NEW_RELEASES_URL}?country=${country}&limit=${limit}`;

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				"User-Agent": "Mozilla/5.0 (compatible; MagicMirror-MusicDisplay/1.0)",
			},
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`new-releases request failed with status ${response.status}: ${body}`);
		}

		const json = await response.json();
		const items = (json.albums && json.albums.items) || [];

		return items.map((album) => ({
			album: album.name || "",
			artist: (album.artists || []).map((a) => a.name).join(", "),
			image: (album.images && album.images[0] && album.images[0].url) || "",
		}));
	},

	checkCurrentPlayback: function () {
		const self = this;
		const statusCmd = `busctl --json=short get-property ${DBUS_DEST} ${DBUS_PATH} ${DBUS_IFACE} PlaybackStatus 2>/dev/null`;

		exec(statusCmd, (err, stdout) => {
			if (err || !stdout.trim()) return;
			try {
				const status = JSON.parse(stdout.trim());
				if (status.data !== "Playing") return;
			} catch (e) {
				return;
			}

			const metaCmd = `busctl --json=short get-property ${DBUS_DEST} ${DBUS_PATH} ${DBUS_IFACE} Metadata 2>/dev/null`;
			exec(metaCmd, (err2, stdout2) => {
				if (err2 || !stdout2.trim()) return;
				try {
					const result = JSON.parse(stdout2.trim());
					const d = result.data;
					const metadata = {};

					if (d["xesam:title"]) metadata.title = String(d["xesam:title"].data);
					if (d["xesam:artist"]) {
						const artist = d["xesam:artist"].data;
						metadata.artist = String(Array.isArray(artist) ? artist[0] : artist);
					}
					if (d["xesam:album"]) metadata.album = String(d["xesam:album"].data);

					if (Object.keys(metadata).length > 0) {
						self.sendSocketNotification("METADATA", metadata);
						self.sendSocketNotification("RESUME", null);
					}

					if (d["mpris:artUrl"] && d["mpris:artUrl"].data) {
						const artPath = String(d["mpris:artUrl"].data).replace("file://", "");
						try {
							const artData = fs.readFileSync(artPath);
							let mime = "image/jpeg";
							if (artData[0] === 0x89 && artData[1] === 0x50) mime = "image/png";
							self.sendSocketNotification("IMAGE", "data:" + mime + ";base64," + artData.toString("base64"));
						} catch (e) {
							// cover art file not accessible
						}
					}

					const lengthUs = d["mpris:length"] && d["mpris:length"].data;
					if (lengthUs) {
						const posCmd = `busctl --json=short get-property ${DBUS_DEST} ${DBUS_PATH} ${DBUS_IFACE} Position 2>/dev/null`;
						exec(posCmd, (err3, stdout3) => {
							if (err3 || !stdout3.trim()) return;
							try {
								const posUs = JSON.parse(stdout3.trim()).data;
								const current = Math.round(posUs / 1000000 * 44100);
								const end = Math.round(lengthUs / 1000000 * 44100);
								self.sendSocketNotification("PROGRESS", "0/" + current + "/" + end);
							} catch (e) {
								// position not available
							}
						});
					}
				} catch (e) {
					// DBUS metadata not available
				}
			});
		});
	},

	startReading: function () {
		const self = this;
		const pipePath = this.config.metadataPipe;

		let buffer = "";
		let state = "IDLE";
		let itemType, itemCode, itemLength;
		let metadata = {};

		const openPipe = () => {
			let stream;
			try {
				stream = fs.createReadStream(pipePath, { encoding: "utf8" });
			} catch (err) {
				setTimeout(openPipe, 5000);
				return;
			}

			stream.on("data", (chunk) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop();

				for (const rawLine of lines) {
					const line = rawLine.trim();
					if (!line) continue;

					if (state === "IDLE") {
						if (!line.startsWith("<item>")) continue;
						const match = line.match(
							/<item><type>([A-Fa-f0-9]{8})<\/type><code>([A-Fa-f0-9]{8})<\/code><length>(\d*)<\/length>/
						);
						if (!match) continue;
						itemType = Buffer.from(match[1], "hex").toString("ascii");
						itemCode = Buffer.from(match[2], "hex").toString("ascii");
						itemLength = parseInt(match[3]);

						if (itemLength > 0) {
							state = "WAIT_DATA_TAG";
						} else {
							self.handleItem(itemType, itemCode, Buffer.alloc(0), metadata);
						}
					} else if (state === "WAIT_DATA_TAG") {
						if (line.startsWith("<data")) {
							state = "WAIT_DATA";
						} else {
							state = "IDLE";
						}
					} else if (state === "WAIT_DATA") {
						const b64size = 4 * Math.ceil(itemLength / 3);
						try {
							const data = Buffer.from(line.substring(0, b64size), "base64");
							self.handleItem(itemType, itemCode, data, metadata);
						} catch (e) {
							// skip malformed data
						}
						state = "IDLE";
					}
				}
			});

			stream.on("error", () => {
				setTimeout(openPipe, 5000);
			});

			stream.on("end", () => {
				setTimeout(openPipe, 1000);
			});
		};

		openPipe();
	},

	handleItem: function (type, code, data, metadata) {
		if (type === "core") {
			if (code === "minm") {
				metadata.title = data.toString("utf8");
			} else if (code === "asar") {
				metadata.artist = data.toString("utf8");
			} else if (code === "asal") {
				metadata.album = data.toString("utf8");
			}
		}

		if (type !== "ssnc") return;

		if (code === "prgr") {
			this.sendSocketNotification("PROGRESS", data.toString("utf8"));
		} else if (code === "PICT") {
			if (data.length === 0) {
				this.sendSocketNotification("IMAGE", "");
			} else {
				let mime = "image/jpeg";
				if (data[0] === 0x89 && data[1] === 0x50) mime = "image/png";
				const uri = "data:" + mime + ";base64," + data.toString("base64");
				this.sendSocketNotification("IMAGE", uri);
			}
		} else if (code === "mden") {
			this.sendSocketNotification("METADATA", metadata);
			Object.keys(metadata).forEach((k) => delete metadata[k]);
		} else if (code === "pfls") {
			this.sendSocketNotification("PAUSE", null);
		} else if (code === "prsm" || code === "pbeg") {
			this.sendSocketNotification("RESUME", null);
		} else if (code === "pend") {
			this.sendSocketNotification("STOP", null);
			Object.keys(metadata).forEach((k) => delete metadata[k]);
		}
	},
});
