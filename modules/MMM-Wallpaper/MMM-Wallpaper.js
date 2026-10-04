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
		this.logs = [];
		this.logEl = null;
		this.captureConsole();
		this.sendSocketNotification("GET_WALLPAPERS");
	},

	captureConsole () {
		["log", "info", "warn", "error", "debug"].forEach((level) => {
			const original = console[level].bind(console);
			console[level] = (...args) => {
				original(...args);
				this.addLog(level, args);
			};
		});
		window.addEventListener("error", (e) => this.addLog("error", [e.message]));
		window.addEventListener("unhandledrejection", (e) => this.addLog("error", ["Unhandled rejection:", e.reason]));
	},

	formatArg (arg) {
		if (arg instanceof Error) {
			return arg.stack || arg.message;
		}
		if (typeof arg === "object" && arg !== null) {
			try {
				return JSON.stringify(arg);
			} catch {
				return String(arg);
			}
		}
		return String(arg);
	},

	addLog (level, args) {
		const time = new Date().toLocaleTimeString();
		const text = args.map((a) => this.formatArg(a)).join(" ");
		this.logs.push({ level, line: `${time} [${level}] ${text}` });
		if (this.logs.length > 300) {
			this.logs.shift();
		}
		if (this.logEl) {
			this.appendLogLine(this.logs[this.logs.length - 1]);
		}
	},

	appendLogLine (entry) {
		const atBottom = this.logEl.scrollTop + this.logEl.clientHeight >= this.logEl.scrollHeight - 5;
		const row = document.createElement("div");
		row.className = `wallpaper-log-line ${entry.level}`;
		row.textContent = entry.line;
		this.logEl.appendChild(row);
		while (this.logEl.childElementCount > 300) {
			this.logEl.firstChild.remove();
		}
		if (atBottom) {
			this.logEl.scrollTop = this.logEl.scrollHeight;
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

		const logTitle = document.createElement("div");
		logTitle.className = "wallpaper-picker-title wallpaper-log-title";
		logTitle.textContent = "Console";
		panel.appendChild(logTitle);

		this.logEl = document.createElement("div");
		this.logEl.className = "wallpaper-log";
		panel.appendChild(this.logEl);

		const restart = document.createElement("button");
		restart.className = "wallpaper-restart-button";
		restart.textContent = "Restart MagicMirror";
		restart.addEventListener("click", () => {
			restart.textContent = "Restarting...";
			restart.disabled = true;
			this.sendSocketNotification("RESTART_APP");
		});
		panel.appendChild(restart);
		this.logs.forEach((entry) => this.appendLogLine(entry));
		this.logEl.scrollTop = this.logEl.scrollHeight;

		overlay.appendChild(panel);
		document.body.appendChild(overlay);
		this.overlayEl = overlay;

		requestAnimationFrame(() => overlay.classList.add("visible"));
	},

	hidePicker () {
		this.pickerVisible = false;
		if (this.overlayEl) {
			this.overlayEl.classList.remove("visible");
			this.logEl = null;
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