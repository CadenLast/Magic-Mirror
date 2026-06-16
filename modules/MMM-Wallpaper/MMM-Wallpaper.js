Module.register("MMM-Wallpaper", {
	defaults: {
		rotateInterval: 60 * 60 * 1000
	},

	start () {
		this.wallpapers = [];
		this.current = 0;
		this.sendSocketNotification("GET_WALLPAPERS");
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "WALLPAPERS" && payload.length) {
			this.wallpapers = payload;
			this.pickRandom();
			setInterval(() => this.pickRandom(), this.config.rotateInterval);
		}
	},

	pickRandom () {
		let next;
		do {
			next = Math.floor(Math.random() * this.wallpapers.length);
		} while (this.wallpapers.length > 1 && next === this.current);
		this.current = next;
		this.applyWallpaper();
	},

	applyWallpaper () {
		const file = this.wallpapers[this.current];
		document.documentElement.style.background =
			`url("config/wallpapers/${file}") center / cover no-repeat`;
	},

	getDom () {
		return document.createElement("span");
	}
});
