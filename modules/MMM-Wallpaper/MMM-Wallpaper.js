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
			const msUntilNextHour = (60 - new Date().getMinutes()) * 60000 - new Date().getSeconds() * 1000 - new Date().getMilliseconds();
			setTimeout(() => {
				this.pickRandom();
				setInterval(() => this.pickRandom(), 60 * 60 * 1000);
			}, msUntilNextHour);
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
			`url("config/darkwallpapers/${file}") center / cover no-repeat`;
	},

	getDom () {
		return document.createElement("span");
	}
});
