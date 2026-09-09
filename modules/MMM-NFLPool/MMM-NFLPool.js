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
		otherDivisionsRotateInterval: 12 * 1000,
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
		this.otherIndex = 0;

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
		this.scheduleRotate();
	},

	getTemplate () {
		return "MMM-NFLPool.njk";
	},

	getTemplateData () {
		const divisions = this.poolData.divisions || [];
		const homeDivision = divisions.find((d) => d.name === this.poolData.homeDivisionName) || null;
		const others = divisions.filter((d) => d.name !== this.poolData.homeDivisionName);
		const currentOther = others.length > 0 ? others[this.otherIndex % others.length] : null;

		return {
			loaded: this.loaded,
			hasGmail: !!this.config.gmail,
			gmailConnected: this.gmailConnected,
			weekLabel: this.poolData.weekLabel,
			divisions,
			homeDivision,
			currentOther,
			rank: this.poolData.rank,
			ofCount: this.poolData.ofCount,
			lastError: this.poolData.lastError,
			retryStatus: this.poolData.retryStatus
		};
	},

	scheduleRefresh () {
		setInterval(() => {
			this.sendSocketNotification("FETCH_POOL", {});
		}, this.config.refreshInterval);
	},

	scheduleRotate () {
		setInterval(() => {
			this.otherIndex += 1;
			this.updateDom(this.config.animationSpeed);
		}, this.config.otherDivisionsRotateInterval);
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
