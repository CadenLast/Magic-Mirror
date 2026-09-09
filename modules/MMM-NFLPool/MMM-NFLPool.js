Module.register("MMM-NFLPool", {
	defaults: {
		gmail: null,
		geminiKey: null,
		geminiModel: "gemini-3.6-flash",
		balldontlieKey: null,
		senderEmail: "bcimorelli@gmail.com",
		userName: "Caden",
		refreshInterval: 30 * 60 * 1000,
		emailScanInterval: 4 * 60 * 60 * 1000,
		liveScoreInterval: 2 * 60 * 1000,
		animationSpeed: 500
	},

	getStyles () {
		return [this.file("MMM-NFLPool.css")];
	},

	start () {
		Log.info(`Starting module: ${this.name}`);
		this.poolData = {
			weekLabel: null,
			week: null,
			divisions: [],
			homeDivisionName: null,
			rank: null,
			ofCount: null,
			parsedAt: null,
			sourceSubject: null,
			lastError: null,
			lastErrorAt: null,
			retryStatus: null
		};
		this.loaded = false;
		this.gmailConnected = !this.config.gmail;

		this.sendSocketNotification("INIT_POOL", {
			gmail: this.config.gmail,
			geminiKey: this.config.geminiKey,
			geminiModel: this.config.geminiModel,
			balldontlieKey: this.config.balldontlieKey,
			senderEmail: this.config.senderEmail,
			userName: this.config.userName,
			address: config.address,
			port: config.port,
			emailScanInterval: this.config.emailScanInterval,
			liveScoreInterval: this.config.liveScoreInterval
		});

		this.scheduleRefresh();
	},

	getTemplate () {
		return "MMM-NFLPool.njk";
	},

	formatDivisionName (name) {
		return name.replace(/^(NFC|AFC)/, "$1 ");
	},

	getTemplateData () {
		const divisions = (this.poolData.divisions || []).map((d) => ({ ...d, displayName: this.formatDivisionName(d.name) }));
		const homeDivision = divisions.find((d) => d.name === this.poolData.homeDivisionName) || null;
		const otherDivisions = divisions.filter((d) => d.name !== this.poolData.homeDivisionName);

		return {
			loaded: this.loaded,
			hasGmail: !!this.config.gmail,
			gmailConnected: this.gmailConnected,
			weekLabel: this.poolData.weekLabel,
			divisions,
			homeDivision,
			otherDivisions,
			lastError: this.poolData.lastError,
			retryStatus: this.poolData.retryStatus
		};
	},

	scheduleRefresh () {
		setInterval(() => {
			this.sendSocketNotification("FETCH_POOL", {});
		}, this.config.refreshInterval);
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "POOL_DATA") {
			this.poolData = payload;
			this.loaded = true;
			this.updateDom(this.config.animationSpeed);
		} else if (notification === "GMAIL_STATUS") {
			this.gmailConnected = payload.connected;
			this.updateDom(this.config.animationSpeed);
		}
	}
});
