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
		this.currentImage = null;
		this.sendSocketNotification("GET_WALLPAPERS");
	},

	notificationReceived (notification) {
		if (notification === "DOM_OBJECTS_CREATED") {
			this.applyContrast();
		}
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
		const url = `config/darkwallpapers/${file}`;
		document.documentElement.style.background = `url("${url}") center / cover no-repeat`;
		this.adaptTextColor(url);
	},

	adaptTextColor (url) {
		const img = new Image();
		img.onload = () => {
			this.currentImage = img;
			this.applyContrast();
		};
		img.src = url;
	},

	// Samples the wallpaper region actually behind each module (mapped through the same
	// "cover" scale/crop the CSS background uses) instead of one whole-image average, since
	// a single dark/light photo can still have bright or dark patches under different modules.
	applyContrast () {
		const img = this.currentImage;
		if (!img) {
			return;
		}

		this.setColors(document.documentElement.style, this.sampleLuminance(img, 0, 0, img.naturalWidth, img.naturalHeight));

		const vw = window.innerWidth;
		const vh = window.innerHeight;
		if (!vw || !vh) {
			return;
		}
		const scale = Math.max(vw / img.naturalWidth, vh / img.naturalHeight);
		const offsetX = (vw - img.naturalWidth * scale) / 2;
		const offsetY = (vh - img.naturalHeight * scale) / 2;

		document.querySelectorAll(".module").forEach((moduleEl) => {
			const rect = moduleEl.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				return;
			}

			const luminance = this.sampleLuminance(
				img,
				(rect.left - offsetX) / scale,
				(rect.top - offsetY) / scale,
				rect.width / scale,
				rect.height / scale
			);
			if (luminance !== null) {
				this.setColors(moduleEl.style, luminance);
			}
		});
	},

	sampleLuminance (img, sx, sy, sw, sh, size = 24) {
		sx = Math.max(0, Math.min(sx, img.naturalWidth));
		sy = Math.max(0, Math.min(sy, img.naturalHeight));
		sw = Math.max(1, Math.min(sw, img.naturalWidth - sx));
		sh = Math.max(1, Math.min(sh, img.naturalHeight - sy));

		const canvas = document.createElement("canvas");
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext("2d");
		try {
			ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
			const data = ctx.getImageData(0, 0, size, size).data;
			let total = 0;
			for (let i = 0; i < data.length; i += 4) {
				total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
			}
			return total / (data.length / 4);
		} catch {
			return null;
		}
	},

	setColors (styleTarget, avgLuminance) {
		const isBright = avgLuminance > 140;
		styleTarget.setProperty("--color-text", isBright ? "#111" : "#fff");
		styleTarget.setProperty("--color-text-bright", isBright ? "#000" : "#fff");
		styleTarget.setProperty("--mm-wallpaper-shadow", isBright ? "rgba(255, 255, 255, 0.85)" : "rgba(0, 0, 0, 0.85)");
	},

	getDom () {
		return document.createElement("span");
	}
});