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
		this.logs = this.loadLogs();
		this.logEl = null;
		this.saveTimer = null;
		this.captureConsole();
		this.addLog("info", ["--- page loaded ---"]);
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
		window.addEventListener("pagehide", () => this.saveLogs());
		window.addEventListener("error", (e) => this.addLog("error", [e.message]));
		window.addEventListener("unhandledrejection", (e) => this.addLog("error", ["Unhandled rejection:", e.reason]));
	},

	loadLogs () {
		try {
			const saved = JSON.parse(localStorage.getItem("wallpaperConsoleLogs"));
			return Array.isArray(saved) ? saved : [];
		} catch {
			return [];
		}
	},

	saveLogs () {
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
		try {
			localStorage.setItem("wallpaperConsoleLogs", JSON.stringify(this.logs));
		} catch {
			// storage unavailable or full
		}
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
		if (!this.saveTimer) {
			this.saveTimer = setTimeout(() => this.saveLogs(), 1000);
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
		if (notification === "SERVER_LOG") {
			this.addServerLines(payload);
			return;
		}
		if (notification === "WIFI_STATUS") {
			this.renderWifi(payload);
			return;
		}
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

		const wifiTitle = document.createElement("div");
		wifiTitle.className = "wallpaper-picker-title wallpaper-log-title";
		wifiTitle.textContent = "WiFi";
		panel.appendChild(wifiTitle);

		this.wifiEl = document.createElement("div");
		this.wifiEl.className = "wallpaper-wifi";
		this.wifiEl.textContent = "Scanning...";
		panel.appendChild(this.wifiEl);
		this.sendSocketNotification("GET_WIFI");
		setTimeout(() => {
			if (this.wifiEl && this.wifiEl.textContent === "Scanning...") {
				this.wifiEl.textContent = "No response from server. Restart MagicMirror to load the latest code.";
			}
		}, 10000);

		const logTitle = document.createElement("div");
		logTitle.className = "wallpaper-picker-title wallpaper-log-title";
		logTitle.textContent = "Console";
		panel.appendChild(logTitle);

		this.logEl = document.createElement("div");
		this.logEl.className = "wallpaper-log";
		panel.appendChild(this.logEl);

		const serverTitle = document.createElement("div");
		serverTitle.className = "wallpaper-picker-title wallpaper-log-title";
		serverTitle.textContent = "Server Logs";
		panel.appendChild(serverTitle);

		this.serverLogEl = document.createElement("div");
		this.serverLogEl.className = "wallpaper-log";
		panel.appendChild(this.serverLogEl);
		this.sendSocketNotification("GET_SERVER_LOG");

		const buttons = document.createElement("div");
		buttons.className = "wallpaper-restart-buttons";
		[
			["Restart MagicMirror", "RESTART_APP"],
			["Restart Wordbot", "RESTART_WORDBOT"]
		].forEach(([label, notification]) => {
			const button = document.createElement("button");
			button.className = "wallpaper-restart-button";
			button.textContent = label;
			button.addEventListener("click", () => {
				button.textContent = "Restarting...";
				button.disabled = true;
				this.sendSocketNotification(notification);
			});
			buttons.appendChild(button);
		});
		panel.appendChild(buttons);
		this.logs.forEach((entry) => this.appendLogLine(entry));
		this.logEl.scrollTop = this.logEl.scrollHeight;

		overlay.appendChild(panel);
		document.body.appendChild(overlay);
		this.overlayEl = overlay;
		this.logEl.scrollTop = this.logEl.scrollHeight;
		this.serverLogEl.scrollTop = this.serverLogEl.scrollHeight;

		requestAnimationFrame(() => overlay.classList.add("visible"));
	},

	addServerLines ({ lines, reset }) {
		const el = this.serverLogEl;
		if (!el) {
			return;
		}
		if (reset) {
			el.textContent = "";
		}
		const atBottom = reset || el.scrollTop + el.clientHeight >= el.scrollHeight - 5;
		lines.forEach((line) => {
			const row = document.createElement("div");
			let level = "info";
			if (/error|fail|exception|ECONN|ETIMEDOUT/i.test(line)) {
				level = "error";
			} else if (/warn|rate.?limit|429/i.test(line)) {
				level = "warn";
			}
			row.className = `wallpaper-log-line ${level}`;
			row.textContent = line;
			el.appendChild(row);
		});
		while (el.childElementCount > 500) {
			el.firstChild.remove();
		}
		if (atBottom) {
			el.scrollTop = el.scrollHeight;
		}
	},

	renderWifi ({ networks, error }) {
		if (!this.wifiEl) {
			return;
		}
		this.wifiEl.textContent = "";
		if (error) {
			this.wifiEl.textContent = `WiFi unavailable: ${error}`;
			return;
		}
		if (!networks.length) {
			this.wifiEl.textContent = "No networks found";
			return;
		}
		networks.forEach((net) => {
			const row = document.createElement("div");
			row.className = "wallpaper-wifi-row";
			if (net.active) {
				row.classList.add("active");
			}
			if (net.saved && !net.active) {
				row.classList.add("saved");
				row.addEventListener("click", () => {
					this.wifiEl.textContent = `Connecting to ${net.ssid}...`;
					this.sendSocketNotification("SET_WIFI", net.ssid);
					setTimeout(() => this.sendSocketNotification("GET_WIFI"), 8000);
				});
			}
			const name = document.createElement("span");
			name.textContent = net.active ? `${net.ssid} (connected)` : net.ssid;
			const signal = document.createElement("span");
			signal.textContent = `${net.signal}%`;
			row.appendChild(name);
			row.appendChild(signal);
			this.wifiEl.appendChild(row);
		});
	},

	hidePicker () {
		this.pickerVisible = false;
		this.wifiEl = null;
		this.serverLogEl = null;
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