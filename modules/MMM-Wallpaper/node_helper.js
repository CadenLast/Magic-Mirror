const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");

module.exports = NodeHelper.create({
	socketNotificationReceived (notification, payload) {
		if (notification === "GET_WALLPAPERS") {
			const dir = path.resolve(__dirname, "../../config/darkwallpapers");
			try {
				const files = fs.readdirSync(dir)
					.filter(f => /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(f))
					.sort();
				this.sendSocketNotification("WALLPAPERS", files);
			} catch {
				this.sendSocketNotification("WALLPAPERS", []);
			}
		}
	}
});
