Module.register("MMM-SportsScores", {
	defaults: {
		sports: [
			{ label: "World Cup", icon: "⚽", sport: "soccer", league: "fifa.world" },
			{ label: "NFL", icon: "🏈", sport: "football", league: "nfl" },
			{ label: "NBA", icon: "🏀", sport: "basketball", league: "nba" },
			{ label: "MLB", icon: "⚾", sport: "baseball", league: "mlb" },
			{ label: "NHL", icon: "🏒", sport: "hockey", league: "nhl" },
			{ label: "NCAAF Top 25", icon: "🏈", sport: "football", league: "college-football", top25: true },
			{ label: "NCAAF", icon: "🏈", sport: "football", league: "college-football" },
			{ label: "NCAAB Top 25", icon: "🏀", sport: "basketball", league: "mens-college-basketball", top25: true },
			{ label: "NCAAB", icon: "🏀", sport: "basketball", league: "mens-college-basketball" }
		],
		favoriteTeams: [],
		refreshInterval: 60 * 1000,
		animationSpeed: 500,
		maxDaysAhead: 7,
		maxDaysBehind: 7,
		showLogos: true
	},

	getScripts () {
		return ["moment.js"];
	},

	getStyles () {
		return [this.file("MMM-SportsScores.css")];
	},

	start () {
		Log.info(`Starting module: ${this.name}`);
		this.dayOffset = 0;
		this.activeSportIndex = 0;
		this.games = [];
		this.loaded = false;
		this.error = null;
		this.requestId = null;
		this.favoriteGames = [];
		this.favoritesRequestId = null;
		this.fetchScores();
		this.fetchFavorites();
		this.scheduleRefresh();

		document.addEventListener("mm-activity", () => {
			if (this._resetTimer) clearTimeout(this._resetTimer);
			this._resetTimer = setTimeout(() => {
				this.resetToDefaults();
			}, config.resetTimeout);
		});
	},

	getTemplate () {
		return "MMM-SportsScores.njk";
	},

	getTemplateData () {
		const targetDate = moment().add(this.dayOffset, "days");

		const games = this.games.map((game) => {
			const g = {
				...game,
				homeTeam: { ...game.homeTeam },
				awayTeam: { ...game.awayTeam }
			};

			if (g.state === "post" || g.state === "in") {
				const hs = parseInt(g.homeTeam.score) || 0;
				const as = parseInt(g.awayTeam.score) || 0;
				g.homeTeam.isWinner = hs > as;
				g.awayTeam.isWinner = as > hs;
			}

			if (g.state === "pre" && g.eventDate) {
				const fmt = config.timeFormat === 24 ? "HH:mm" : "h:mm A";
				g.displayTime = moment(g.eventDate).format(fmt);
			} else {
				g.displayTime = g.detail;
			}

			return g;
		});

		const favorites = this.favoriteGames.map((game) => {
			const g = {
				...game,
				homeTeam: { ...game.homeTeam, isFavorite: game.favoriteIsHome },
				awayTeam: { ...game.awayTeam, isFavorite: game.favoriteIsAway }
			};

			if (g.state === "post" || g.state === "in") {
				const hs = parseInt(g.homeTeam.score) || 0;
				const as = parseInt(g.awayTeam.score) || 0;
				g.homeTeam.isWinner = hs > as;
				g.awayTeam.isWinner = as > hs;
			}

			if (g.state === "pre" && g.eventDate) {
				const fmt = config.timeFormat === 24 ? "HH:mm" : "h:mm A";
				g.displayTime = moment(g.eventDate).format(fmt);
			} else {
				g.displayTime = g.detail;
			}

			return g;
		});

		return {
			loaded: this.loaded,
			error: this.error,
			dateLabel: targetDate.format("ddd, MMM D"),
			isToday: this.dayOffset === 0,
			sports: this.config.sports,
			activeSportIndex: this.activeSportIndex,
			favorites: favorites,
			games: games,
			showLogos: this.config.showLogos,
			canGoBack: true,
			canGoForward: true
		};
	},

	getDom () {
		return this._super().then((dom) => {
			const prev = dom.querySelector(".scores-prev");
			const next = dom.querySelector(".scores-next");

			if (prev) {
				prev.addEventListener("click", () => {
					this.dayOffset--;
					this.updateDateLabel();
					this.dimContent();
					this.fetchScores();
					this.fetchFavorites();
					this.broadcastInteraction();
				});
			}

			if (next) {
				next.addEventListener("click", () => {
					this.dayOffset++;
					this.updateDateLabel();
					this.dimContent();
					this.fetchScores();
					this.fetchFavorites();
					this.broadcastInteraction();
				});
			}

			const dateEl = dom.querySelector(".scores-date");
			if (dateEl) {
				dateEl.addEventListener("click", () => {
					this.showCalendar();
				});
			}

			dom.querySelectorAll(".scores-game-clickable").forEach((el) => {
				el.addEventListener("click", () => {
					const url = el.dataset.url;
					const title = el.dataset.title;
					if (url) this.showGamePopup(url, title);
				});
			});

			const menu = dom.querySelector(".scores-sport-menu");
			const toggle = dom.querySelector(".scores-sport-toggle");
			if (toggle && menu) {
				toggle.addEventListener("click", (e) => {
					e.stopPropagation();
					menu.classList.toggle("open");
				});
			}

			const options = dom.querySelectorAll(".scores-sport-option");
			options.forEach((opt) => {
				opt.addEventListener("click", (e) => {
					e.stopPropagation();
					const index = parseInt(opt.dataset.index);
					menu.classList.remove("open");
					if (index !== this.activeSportIndex) {
						this.activeSportIndex = index;
						this.updateSportLabel();
						this.dimContent();
						this.fetchScores();
					}
					this.broadcastInteraction();
				});
			});

			const gamesList = dom.querySelector(".scores-games");
			const indicator = dom.querySelector(".scores-scroll-indicator");
			if (gamesList && indicator) {
				const updateIndicator = () => {
					const canScroll = gamesList.scrollHeight > gamesList.clientHeight;
					const atBottom = gamesList.scrollTop + gamesList.clientHeight >= gamesList.scrollHeight - 2;
					indicator.classList.toggle("visible", canScroll && !atBottom);
				};
				gamesList.addEventListener("scroll", () => {
					updateIndicator();
					this.broadcastInteraction();
				});
				this._updateScrollIndicator = updateIndicator;
			}

			return dom;
		});
	},

	updateDateLabel () {
		const wrapper = document.getElementById(this.identifier);
		if (!wrapper) return;
		const dateEl = wrapper.querySelector(".scores-date");
		if (!dateEl) return;
		const targetDate = moment().add(this.dayOffset, "days");
		dateEl.textContent = this.dayOffset === 0 ? "Today" : targetDate.format("ddd, MMM D");
	},

	updateSportLabel () {
		const wrapper = document.getElementById(this.identifier);
		if (!wrapper) return;
		const label = wrapper.querySelector(".scores-sport-label");
		if (!label) return;
		const sport = this.config.sports[this.activeSportIndex];
		label.textContent = `${sport.icon} ${sport.label}`;
	},

	dimContent () {
		const wrapper = document.getElementById(this.identifier);
		if (!wrapper) return;
		wrapper.querySelectorAll(".scores-games-container, .scores-empty").forEach((el) => {
			el.style.opacity = "0.3";
		});
	},


	showCalendar () {
		this.closeCalendar();

		const today = moment();
		const selected = moment().add(this.dayOffset, "days");
		this.calendarMonth = selected.month();
		this.calendarYear = selected.year();

		const overlay = document.createElement("div");
		overlay.className = "scores-calendar-overlay";
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) this.closeCalendar();
		});

		const cal = document.createElement("div");
		cal.className = "scores-calendar";

		this.calendarEl = cal;
		this.calendarOverlay = overlay;
		this.renderCalendarMonth(today, selected);

		overlay.appendChild(cal);
		document.body.appendChild(overlay);
	},

	renderCalendarMonth (today, selected) {
		const cal = this.calendarEl;
		cal.innerHTML = "";

		today = today || moment();
		selected = selected || moment().add(this.dayOffset, "days");
		const displayMonth = moment([this.calendarYear, this.calendarMonth, 1]);

		const header = document.createElement("div");
		header.className = "scores-calendar-header";

		const prevBtn = document.createElement("span");
		prevBtn.className = "scores-calendar-nav";
		prevBtn.innerHTML = "&lsaquo;";
		prevBtn.addEventListener("click", () => {
			this.calendarMonth--;
			if (this.calendarMonth < 0) {
				this.calendarMonth = 11;
				this.calendarYear--;
			}
			this.renderCalendarMonth(today, selected);
		});

		const monthLabel = document.createElement("span");
		monthLabel.className = "scores-calendar-month-label";
		monthLabel.textContent = displayMonth.format("MMMM YYYY");

		const nextBtn = document.createElement("span");
		nextBtn.className = "scores-calendar-nav";
		nextBtn.innerHTML = "&rsaquo;";
		nextBtn.addEventListener("click", () => {
			this.calendarMonth++;
			if (this.calendarMonth > 11) {
				this.calendarMonth = 0;
				this.calendarYear++;
			}
			this.renderCalendarMonth(today, selected);
		});

		header.appendChild(prevBtn);
		header.appendChild(monthLabel);
		header.appendChild(nextBtn);
		cal.appendChild(header);

		const grid = document.createElement("div");
		grid.className = "scores-calendar-grid";

		const dayNames = ["S", "M", "T", "W", "T", "F", "S"];
		dayNames.forEach((d) => {
			const span = document.createElement("span");
			span.className = "scores-cal-header";
			span.textContent = d;
			grid.appendChild(span);
		});

		const startDow = displayMonth.day();
		const daysInMonth = displayMonth.daysInMonth();

		for (let i = 0; i < startDow; i++) {
			const empty = document.createElement("span");
			empty.className = "scores-cal-day scores-cal-empty";
			grid.appendChild(empty);
		}

		for (let d = 1; d <= daysInMonth; d++) {
			const dayMoment = moment([this.calendarYear, this.calendarMonth, d]);
			const span = document.createElement("span");
			span.className = "scores-cal-day";
			span.textContent = d;

			if (dayMoment.isSame(today, "day")) {
				span.classList.add("scores-cal-today");
			}
			if (dayMoment.isSame(selected, "day")) {
				span.classList.add("scores-cal-selected");
			}

			span.addEventListener("click", () => {
				this.dayOffset = dayMoment.diff(moment(today).startOf("day"), "days");
				this.closeCalendar();
				this.updateDateLabel();
				this.dimContent();
				this.fetchScores();
				this.fetchFavorites();
				this.broadcastInteraction();
			});

			grid.appendChild(span);
		}

		const totalCells = startDow + daysInMonth;
		const trailing = (Math.ceil(totalCells / 7) < 6) ? 42 - totalCells : 0;
		for (let i = 0; i < trailing; i++) {
			const empty = document.createElement("span");
			empty.className = "scores-cal-day scores-cal-empty";
			grid.appendChild(empty);
		}

		cal.appendChild(grid);
	},

	closeCalendar () {
		if (this.calendarOverlay) {
			this.calendarOverlay.remove();
			this.calendarOverlay = null;
			this.calendarEl = null;
		}
	},

	showGamePopup (url, title) {
		this.closeGamePopup();

		const overlay = document.createElement("div");
		overlay.className = "scores-popup-overlay";

		const header = document.createElement("div");
		header.className = "scores-popup-header";

		const titleEl = document.createElement("span");
		titleEl.className = "scores-popup-title";
		titleEl.textContent = title || "Game Details";

		const closeBtn = document.createElement("span");
		closeBtn.className = "scores-popup-close";
		closeBtn.innerHTML = "&times;";
		closeBtn.addEventListener("click", () => this.closeGamePopup());

		header.appendChild(titleEl);
		header.appendChild(closeBtn);

		const iframe = document.createElement("iframe");
		iframe.className = "scores-popup-iframe";
		iframe.src = url;

		overlay.appendChild(header);
		overlay.appendChild(iframe);

		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) this.closeGamePopup();
		});

		document.body.appendChild(overlay);
		this.gamePopupOverlay = overlay;
	},

	closeGamePopup () {
		if (this.gamePopupOverlay) {
			this.gamePopupOverlay.remove();
			this.gamePopupOverlay = null;
		}
	},

	fetchScores () {
		const sport = this.config.sports[this.activeSportIndex];
		const targetDate = moment().add(this.dayOffset, "days").format("YYYYMMDD");
		this.requestId = `${this.activeSportIndex}-${this.dayOffset}-${Date.now()}`;
		this.sendSocketNotification("FETCH_SCORES", {
			sport: sport.sport,
			league: sport.league,
			date: targetDate,
			top25: sport.top25 || false,
			requestId: this.requestId
		});
	},

	fetchFavorites () {
		if (!this.config.favoriteTeams || this.config.favoriteTeams.length === 0) return;
		const targetDate = moment().add(this.dayOffset, "days").format("YYYYMMDD");
		this.favoritesRequestId = `fav-${this.dayOffset}-${Date.now()}`;
		this.sendSocketNotification("FETCH_FAVORITES", {
			date: targetDate,
			favorites: this.config.favoriteTeams,
			requestId: this.favoritesRequestId
		});
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "SCORES_DATA" && payload.requestId === this.requestId) {
			this.games = payload.games;
			this.loaded = true;
			this.error = null;
			this.updateDom(0);
		} else if (notification === "SCORES_ERROR" && payload.requestId === this.requestId) {
			this.error = payload.message;
			this.loaded = true;
			this.updateDom(0);
		} else if (notification === "FAVORITES_DATA" && payload.requestId === this.favoritesRequestId) {
			this.favoriteGames = payload.games;
			this.updateDom(0);
		}
	},

	notificationReceived (notification) {
		if (notification === "MODULE_DOM_UPDATED" && this._updateScrollIndicator) {
			this._updateScrollIndicator();
		}
	},

	broadcastInteraction () {
		document.dispatchEvent(new Event("mm-activity"));
	},

	resetToDefaults () {
		if (this.dayOffset !== 0) {
			this.dayOffset = 0;
			this.fetchScores();
			this.fetchFavorites();
		}
		this.updateDom(0).then(() => {
			const wrapper = document.getElementById(this.identifier);
			if (!wrapper) return;
			const list = wrapper.querySelector(".scores-games");
			if (list) list.scrollTop = 0;
		});
	},

	scheduleRefresh () {
		setInterval(() => {
			this.fetchScores();
			this.fetchFavorites();
		}, this.config.refreshInterval);
	}
});
