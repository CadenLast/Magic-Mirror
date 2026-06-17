const NodeHelper = require("node_helper");
const fs = require("fs");

module.exports = NodeHelper.create({
	start: function () {
		this.reading = false;
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "CONFIG" && !this.reading) {
			this.config = payload;
			this.reading = true;
			this.startReading();
		}
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
				console.error(self.name + ": failed to open pipe:", err.message);
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

			stream.on("error", (err) => {
				console.error(self.name + ": pipe error:", err.message);
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
