const NodeHelper = require("node_helper");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { exec } = require("child_process");

const DBUS_DEST = "org.gnome.ShairportSync";
const DBUS_PATH = "/org/mpris/MediaPlayer2";
const DBUS_IFACE = "org.mpris.MediaPlayer2.Player";
const ART_CACHE_FILE = path.join(__dirname, "art_cache.json");

module.exports = NodeHelper.create({
	start: function () {
		this.reading = false;
		this.artCache = this.loadArtCache();
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "CONFIG" && !this.reading) {
			this.config = payload;
			this.reading = true;
			this.startReading();
			this.checkCurrentPlayback();
			this.loadFavorites();
		}
	},

	loadArtCache: function () {
		try {
			return JSON.parse(fs.readFileSync(ART_CACHE_FILE, "utf8"));
		} catch (e) {
			return {};
		}
	},

	saveArtCache: function () {
		try {
			fs.writeFileSync(ART_CACHE_FILE, JSON.stringify(this.artCache));
		} catch (e) {
			// ignore
		}
	},

	loadFavorites: function () {
		const favorites = this.config.favorites || [];
		if (favorites.length === 0) return;

		let pending = favorites.length;
		const results = [];

		favorites.forEach((fav, i) => {
			const cacheKey = fav.artist + " - " + fav.album;

			const finish = (image) => {
				results[i] = {
					title: fav.title || "",
					artist: fav.artist || "",
					album: fav.album || "",
					image: image || "",
				};
				pending--;
				if (pending === 0) {
					this.sendSocketNotification(
						"RECENT_TRACKS",
						results.filter((r) => r)
					);
				}
			};

			if (this.artCache[cacheKey]) {
				finish(this.artCache[cacheKey]);
			} else {
				this.lookupArtwork(fav.artist, fav.album, (url) => {
					if (url) {
						this.artCache[cacheKey] = url;
						this.saveArtCache();
					}
					finish(url);
				});
			}
		});
	},

	lookupArtwork: function (artist, album, callback) {
		const query = encodeURIComponent(artist + " " + album);
		const url = "https://itunes.apple.com/search?term=" + query + "&entity=album&limit=1";

		https
			.get(url, (res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => {
					try {
						const json = JSON.parse(body);
						if (json.results && json.results.length > 0 && json.results[0].artworkUrl100) {
							callback(json.results[0].artworkUrl100.replace("100x100bb", "600x600bb"));
						} else {
							callback("");
						}
					} catch (e) {
						callback("");
					}
				});
			})
			.on("error", () => callback(""));
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
