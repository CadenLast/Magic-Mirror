Module.register("MMM-Wallpaper", {
	defaults: {
		rotateInterval: 60 * 60 * 1000
	},

	getStyles () {
		return ["MMM-Wallpaper.css"];
	},

	start () {
		this.wallpapers = [];
		this.current = 0;
		this.pickerVisible = false;
		this.sendSocketNotification("GET_WALLPAPERS");
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "WALLPAPERS" && payload.length) {
			this.wallpapers = payload;
			this.pickRandom();
			const msSinceMidnight = Date.now() - new Date().setHours(0, 0, 0, 0);
			const msUntilNext = this.config.rotateInterval - (msSinceMidnight % this.config.rotateInterval);
			setTimeout(() => {
				this.pickRandom();
				setInterval(() => this.pickRandom(), this.config.rotateInterval);
			}, msUntilNext);
			this.attachClockClickHandler();
		}
	},

	attachClockClickHandler () {
		const clockEl = document.querySelector(".module.clock .module-content");
		if (!clockEl) {
			setTimeout(() => this.attachClockClickHandler(), 1000);
			return;
		}
		clockEl.style.cursor = "pointer";
		clockEl.addEventListener("click", (e) => {
			e.stopPropagation();
			this.togglePicker();
		});
	},

	togglePicker () {
		if (this.pickerVisible) {
			this.hidePicker();
		} else {
			this.showPicker();
		}
	},

	showPicker () {
		this.pickerVisible = true;

		const overlay = document.createElement("div");
		overlay.className = "wallpaper-picker-overlay";
		overlay.addEventListener("click", () => this.hidePicker());

		const panel = document.createElement("div");
		panel.className = "wallpaper-picker-panel";
		panel.addEventListener("click", (e) => e.stopPropagation());

		const title = document.createElement("div");
		title.className = "wallpaper-picker-title";
		title.textContent = "Choose Background";
		panel.appendChild(title);

		const grid = document.createElement("div");
		grid.className = "wallpaper-picker-grid";

		this.wallpapers.forEach((file, index) => {
			const item = document.createElement("div");
			item.className = "wallpaper-picker-item";
			if (index === this.current) {
				item.classList.add("active");
			}

			const img = document.createElement("img");
			img.src = `config/darkwallpapers/${file}`;
			img.alt = file;
			item.appendChild(img);

			const label = document.createElement("div");
			label.className = "wallpaper-picker-label";
			label.textContent = file.replace(/\.[^.]+$/, "");
			item.appendChild(label);

			item.addEventListener("click", () => {
				this.current = index;
				this.applyWallpaper();
				this.hidePicker();
			});

			grid.appendChild(item);
		});

		panel.appendChild(grid);
		overlay.appendChild(panel);
		document.body.appendChild(overlay);
		this.overlayEl = overlay;

		requestAnimationFrame(() => overlay.classList.add("visible"));
	},

	hidePicker () {
		this.pickerVisible = false;
		if (this.overlayEl) {
			this.overlayEl.classList.remove("visible");
			setTimeout(() => {
				this.overlayEl.remove();
				this.overlayEl = null;
			}, 200);
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
