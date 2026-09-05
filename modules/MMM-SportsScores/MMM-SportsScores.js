Module.register("MMM-SportsScores", {
	defaults: {
		sports: [
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
		showLogos: true,
		// Optional: route the NFL/NBA/NCAAF/NCAAB ESPN requests through a proxy
		// (e.g. a Cloudflare Worker) instead of calling ESPN directly, to work
		// around Akamai blocking a specific home IP. Leave url empty to call
		// ESPN directly as normal.
		espnProxy: {
			url: "",
			key: ""
		},
		// Optional: balldontlie.io API keys, one per sport/league (its free tier
		// scopes a key to a single sport). Used for game/score data on sports
		// listed here instead of ESPN; e.g. { nfl: "...", nba: "..." }.
		balldontlieKeys: {},
		// Optional: specific college teams to show as favorites, pulled directly
		// from their own athletics department site rather than a league-wide
		// source (there isn't a reliable free one for NCAAF/NCAAB game data).
		// e.g. [{ sport: "football", team: "Iowa" }] - see COLLEGE_TEAM_SOURCES
		// in node_helper.js for which teams are actually supported.
		collegeTeams: [],
		// Optional: a CollegeFootballData.com API key (also works directly on
		// its sister site CollegeBasketballData.com - same account). Used for
		// NCAAF/NCAAB "standings", which is actually the AP Top 25 poll.
		cfbdKey: ""
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
		this.gamesLoading = false;
		this.error = null;
		this.requestId = null;
		this.favoriteGames = [];
		this.favoritesRequestId = null;
		this.standingsGroups = [];
		this.standingsLoaded = false;
		this.standingsError = null;
		this.standingsRequestId = null;
		this.isRankingsView = false;
		this.standingsView = "league";
		this._standingsOnlyUpdate = false;
		this.runStaggeredRefresh();
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

	getFavoriteNameSubstrings () {
		const sport = this.config.sports[this.activeSportIndex];
		if (!sport) return [];

		const favoriteNames = (this.config.favoriteTeams || [])
			.filter((f) => f.sport === sport.sport && f.league === sport.league)
			.map((f) => f.team.toLowerCase());

		// collegeTeams entries don't have a league field (they're pulled from
		// each team's own site, not a league-wide source), so this only
		// matches on sport - fine in practice, since it's only relevant for
		// the two college leagues to begin with.
		const isCollegeLeague = sport.league === "college-football" || sport.league === "mens-college-basketball";
		const collegeNames = isCollegeLeague
			? (this.config.collegeTeams || []).filter((t) => t.sport === sport.sport).map((t) => t.team.toLowerCase())
			: [];

		return [...favoriteNames, ...collegeNames];
	},

	// Some leagues (NFL, NHL) have no real games-behind concept, so
	// node_helper sends gamesBehind: null for those rather than "-" - showing
	// a whole column of dashes for every team was just wasted width that
	// pushed the row into getting clipped. Only render the column at all if
	// at least one team actually has a real value.
	standingsHasGamesBehind (groups) {
		return groups.some((group) => group.teams.some((team) => team.gamesBehind !== null && team.gamesBehind !== undefined));
	},

	annotateStandingsFavorites (groups) {
		const favoriteNames = this.getFavoriteNameSubstrings();
		if (favoriteNames.length === 0) return groups;
		return groups.map((group) => ({
			...group,
			teams: group.teams.map((team) => ({
				...team,
				isFavorite: favoriteNames.some((name) => team.name.toLowerCase().includes(name))
			}))
		}));
	},

	getTemplateData () {
		const targetDate = moment().add(this.dayOffset, "days");

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

		// Anything already surfaced up in the favorites section would just be
		// a duplicate of itself down here in the full games list.
		const favoriteIds = new Set(favorites.map((g) => g.id));
		const games = this.games.filter((game) => !favoriteIds.has(game.id)).map((game) => {
			const g = {
				...game,
				// The NCAAF/NCAAB tabs only ever show tracked teams' own games
				// (see node_helper's college-teams-aggregate provider), which
				// already carry these fields from the same parsers used for
				// favorites - other sports' games just get isFavorite:
				// undefined here, same as before.
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
			gamesLoading: this.gamesLoading,
			showLogos: this.config.showLogos,
			canGoBack: true,
			canGoForward: true,
			standingsLoaded: this.standingsLoaded,
			standingsError: this.standingsError,
			standingsGroups: this.annotateStandingsFavorites(this.standingsGroups),
			hasGamesBehind: this.standingsHasGamesBehind(this.standingsGroups),
			isRankings: this.isRankingsView,
			isHockey: this.config.sports[this.activeSportIndex].league === "nhl",
			standingsView: this.standingsView
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
					this.clearGamesForDaySwitch();
					this.fetchScores();
					this.fetchFavorites();
					this.broadcastInteraction();
				});
			}

			if (next) {
				next.addEventListener("click", () => {
					this.dayOffset++;
					this.updateDateLabel();
					this.clearGamesForDaySwitch();
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
						this._standingsOnlyUpdate = false;
						this.fetchScores();
						this.fetchStandings();
					}
					this.broadcastInteraction();
				});
			});

			const standingsViewToggle = dom.querySelector(".standings-view-toggle");
			if (standingsViewToggle) {
				standingsViewToggle.addEventListener("click", (e) => {
					e.stopPropagation();
					// Rankings (AP Top 25) have no league/division split - the
					// label there is just the poll name, not a toggle.
					if (this.isRankingsView) return;
					this.standingsView = this.standingsView === "league" ? "division" : "league";
					this.updateStandingsViewLabel();
					this.dimStandingsColumn();
					this._standingsOnlyUpdate = true;
					this.fetchStandings();
					this.broadcastInteraction();
				});
			}

			const gamesUpdate = this.bindScrollIndicator(dom.querySelector(".scores-games"), dom.querySelector(".scores-games-container .scores-scroll-indicator"));
			this._gamesScrollUpdate = gamesUpdate;
			this._standingsScrollUpdate = this.bindScrollIndicator(dom.querySelector(".standings-list"), dom.querySelector(".standings-container .scores-scroll-indicator"));
			this._updateScrollIndicator = () => {
				if (this._gamesScrollUpdate) this._gamesScrollUpdate();
				if (this._standingsScrollUpdate) this._standingsScrollUpdate();
			};

			return dom;
		});
	},

	bindScrollIndicator (listEl, indicatorEl) {
		if (!listEl || !indicatorEl) return null;
		const update = () => {
			const canScroll = listEl.scrollHeight > listEl.clientHeight;
			const atBottom = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 2;
			indicatorEl.classList.toggle("visible", canScroll && !atBottom);
		};
		listEl.addEventListener("scroll", () => {
			update();
			this.broadcastInteraction();
		});
		return update;
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

	updateStandingsViewLabel () {
		const wrapper = document.getElementById(this.identifier);
		if (!wrapper) return;
		const label = wrapper.querySelector(".standings-view-label");
		if (!label) return;
		label.textContent = this.standingsView === "division" ? "Division" : "League";
	},

	_escapeHtml (value) {
		return String(value).replace(/[&<>"']/g, (c) => ({
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			"\"": "&quot;",
			"'": "&#39;"
		}[c]));
	},

	renderStandingsContent () {
		if (this.standingsError) {
			return `<div class="dimmed small scores-empty">Unable to load standings</div>`;
		}
		if (!this.standingsLoaded) {
			return `<div class="dimmed small scores-empty">Loading standings&hellip;</div>`;
		}
		if (!this.standingsGroups || this.standingsGroups.length === 0) {
			return `<div class="dimmed small scores-empty">No standings available</div>`;
		}

		const hasGamesBehind = this.standingsHasGamesBehind(this.standingsGroups);
		const isHockey = this.config.sports[this.activeSportIndex].league === "nhl";
		const groupsHtml = this.annotateStandingsFavorites(this.standingsGroups).map((group) => {
			const teamsHtml = group.teams.map((team) => {
				const logo = (this.config.showLogos && team.logo)
					? `<img class="scores-logo" src="${this._escapeHtml(team.logo)}" alt="" />`
					: "";
				const rankOrSeed = this._escapeHtml(this.isRankingsView ? team.rank : team.seed);
				const gb = hasGamesBehind ? `<span class="standings-gb">${this._escapeHtml(team.gamesBehind)}</span>` : "";
				const statClass = ["standings-stat", isHockey ? "standings-stat-wide" : ""].filter(Boolean).join(" ");
				const extra = this.isRankingsView
					? ""
					: `<span class="${statClass}">${this._escapeHtml(team.stat)}</span>
					   ${gb}`;
				const abbrClass = ["scores-abbr", this.isRankingsView ? "standings-abbr-wide" : "", team.isFavorite ? "scores-favorite" : ""].filter(Boolean).join(" ");
				const recordClass = ["standings-record", isHockey ? "standings-record-wide" : ""].filter(Boolean).join(" ");
				return `<div class="standings-row">
					<span class="standings-team">
						<span class="standings-rank">${rankOrSeed}</span>
						${logo}
						<span class="${abbrClass}">${this._escapeHtml(team.abbreviation)}</span>
					</span>
					<span class="${recordClass}">${this._escapeHtml(team.record)}</span>
					${extra}
				</div>`;
			}).join("");

			const header = this.isRankingsView ? "" : `<div class="standings-group-header">${this._escapeHtml(group.name)}</div>`;
			return `<div class="standings-group">
				${header}
				${teamsHtml}
			</div>`;
		}).join("");

		return `<div class="scores-games-container standings-container">
			<div class="scores-games standings-list">${groupsHtml}</div>
			<div class="scores-scroll-indicator">&lsaquo;</div>
		</div>`;
	},

	updateStandingsColumn () {
		const wrapper = document.getElementById(this.identifier);
		const column = wrapper ? wrapper.querySelector(".standings-column") : null;
		if (!column) {
			this.updateDom(300);
			return;
		}
		column.innerHTML = this.renderStandingsContent();
		column.style.opacity = "1";
		this._standingsScrollUpdate = this.bindScrollIndicator(column.querySelector(".standings-list"), column.querySelector(".standings-container .scores-scroll-indicator"));
		if (this._standingsScrollUpdate) this._standingsScrollUpdate();
	},

	dimContent () {
		const wrapper = document.getElementById(this.identifier);
		if (!wrapper) return;
		wrapper.querySelectorAll(".scores-games-container, .standings-container, .scores-empty").forEach((el) => {
			el.style.opacity = "0.3";
		});
	},

	// Switching days used to just dim the previous day's games while the new
	// day's data was in flight - since games/favorites arrive from separate,
	// independently-timed requests, that left a window where one had already
	// updated and the other hadn't, showing a mismatched mix of two different
	// days at once. Clearing both immediately avoids that entirely.
	clearGamesForDaySwitch () {
		this.games = [];
		this.favoriteGames = [];
		this.gamesLoading = true;
		this.updateDom(0);
	},

	dimStandingsColumn () {
		const wrapper = document.getElementById(this.identifier);
		if (!wrapper) return;
		const column = wrapper.querySelector(".standings-column");
		if (column) column.style.opacity = "0.3";
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
				this.clearGamesForDaySwitch();
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
			espnProxy: this.config.espnProxy,
			balldontlieKeys: this.config.balldontlieKeys,
			collegeTeams: this.config.collegeTeams,
			cfbdKey: this.config.cfbdKey,
			requestId: this.requestId
		});
	},

	fetchFavorites () {
		const hasFavorites = this.config.favoriteTeams && this.config.favoriteTeams.length > 0;
		const hasCollegeTeams = this.config.collegeTeams && this.config.collegeTeams.length > 0;
		if (!hasFavorites && !hasCollegeTeams) return;
		const targetDate = moment().add(this.dayOffset, "days").format("YYYYMMDD");
		this.favoritesRequestId = `fav-${this.dayOffset}-${Date.now()}`;
		this.sendSocketNotification("FETCH_FAVORITES", {
			date: targetDate,
			favorites: this.config.favoriteTeams || [],
			collegeTeams: this.config.collegeTeams || [],
			espnProxy: this.config.espnProxy,
			balldontlieKeys: this.config.balldontlieKeys,
			cfbdKey: this.config.cfbdKey,
			requestId: this.favoritesRequestId
		});
	},

	fetchStandings () {
		const sport = this.config.sports[this.activeSportIndex];
		this.standingsRequestId = `standings-${this.activeSportIndex}-${Date.now()}`;
		this.sendSocketNotification("FETCH_STANDINGS", {
			sport: sport.sport,
			league: sport.league,
			top25: sport.top25 || false,
			view: this.standingsView,
			espnProxy: this.config.espnProxy,
			cfbdKey: this.config.cfbdKey,
			requestId: this.standingsRequestId
		});
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "SCORES_DATA" && payload.requestId === this.requestId) {
			const oldGames = this.games;
			this.games = payload.games;
			this.loaded = true;
			this.gamesLoading = false;
			this.error = null;
			if (this._canPatch(oldGames, payload.games)) {
				this._patchGames(oldGames, payload.games, "game");
			} else {
				this.updateDom(300);
			}
		} else if (notification === "SCORES_ERROR" && payload.requestId === this.requestId) {
			this.error = payload.message;
			this.loaded = true;
			this.gamesLoading = false;
			this.updateDom(300);
		} else if (notification === "FAVORITES_DATA" && payload.requestId === this.favoritesRequestId) {
			const oldFavorites = this.favoriteGames;
			this.favoriteGames = payload.games;
			if (this._canPatch(oldFavorites, payload.games)) {
				this._patchGames(oldFavorites, payload.games, "fav");
			} else {
				this.updateDom(300);
			}
		} else if (notification === "STANDINGS_DATA" && payload.requestId === this.standingsRequestId) {
			this.standingsGroups = payload.groups;
			this.isRankingsView = payload.isRankings;
			this.standingsLoaded = true;
			this.standingsError = null;
			this.refreshStandingsDisplay();
		} else if (notification === "STANDINGS_ERROR" && payload.requestId === this.standingsRequestId) {
			this.standingsError = payload.message;
			this.standingsLoaded = true;
			this.refreshStandingsDisplay();
		}
	},

	refreshStandingsDisplay () {
		// Only take the lightweight column-only patch when nothing else on the
		// module is changing (e.g. the League/Division toggle). If a sport
		// switch or scheduled refresh is also touching scores, a competing
		// full updateDom() can finish after this patch and clobber it with
		// stale data, so fall back to the normal full re-render there.
		if (this._standingsOnlyUpdate) {
			this.updateStandingsColumn();
		} else {
			this.updateDom(300);
		}
		this._standingsOnlyUpdate = false;
	},

	_canPatch (oldGames, newGames) {
		if (!oldGames || oldGames.length === 0) return false;
		if (oldGames.length !== newGames.length) return false;
		for (let i = 0; i < oldGames.length; i++) {
			if (oldGames[i].id !== newGames[i].id) return false;
			if (!this._situationEqual(oldGames[i].situation, newGames[i].situation)) return false;
		}
		return true;
	},

	_situationEqual (a, b) {
		if (!a && !b) return true;
		if (!a || !b) return false;
		return JSON.stringify(a) === JSON.stringify(b);
	},

	_prepareGame (game) {
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
	},

	_patchGames (oldGames, newGames, prefix) {
		const wrapper = document.getElementById(this.identifier);
		if (!wrapper) return;
		for (let i = 0; i < newGames.length; i++) {
			const oldGame = this._prepareGame(oldGames[i]);
			const newGame = this._prepareGame(newGames[i]);
			const el = wrapper.querySelector(`[data-game-id="${prefix}-${newGame.id}"]`);
			if (!el) continue;
			this._patchGameElement(el, oldGame, newGame);
		}
	},

	_patchGameElement (el, oldGame, newGame) {
		const rows = el.querySelectorAll(".scores-team-row");
		if (rows.length < 2) return;

		this._patchTeamScore(rows[0], oldGame.awayTeam, newGame.awayTeam, oldGame.state, newGame.state);
		this._patchTeamScore(rows[1], oldGame.homeTeam, newGame.homeTeam, oldGame.state, newGame.state);

		rows[0].classList.toggle("scores-winner", !!newGame.awayTeam.isWinner);
		rows[1].classList.toggle("scores-winner", !!newGame.homeTeam.isWinner);

		if (oldGame.displayTime !== newGame.displayTime) {
			const spans = el.querySelectorAll(".scores-detail span");
			const detailSpan = spans[spans.length - 1];
			if (detailSpan) {
				detailSpan.classList.add("scores-score-changed");
				detailSpan.textContent = newGame.displayTime;
				setTimeout(() => detailSpan.classList.remove("scores-score-changed"), 500);
			}
		}

		const hasLiveDot = !!el.querySelector(".scores-live-dot");
		if (newGame.state === "in" && !hasLiveDot) {
			const dot = document.createElement("span");
			dot.className = "scores-live-dot";
			el.querySelector(".scores-detail").prepend(dot);
		} else if (newGame.state !== "in" && hasLiveDot) {
			el.querySelector(".scores-live-dot").remove();
		}

		el.classList.toggle("scores-game-live", newGame.state === "in");
	},

	_patchTeamScore (row, oldTeam, newTeam, oldState, newState) {
		const scoreEl = row.querySelector(".scores-score");
		if (!scoreEl) return;
		const newDisplay = newState === "pre" ? "–" : newTeam.score;
		if (scoreEl.textContent.trim() !== String(newDisplay)) {
			scoreEl.classList.add("scores-score-changed");
			scoreEl.textContent = newDisplay;
			setTimeout(() => scoreEl.classList.remove("scores-score-changed"), 800);
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

	runStaggeredRefresh () {
		// Spread these out instead of firing every request in the same instant -
		// a burst of simultaneous connections every minute, on the dot, is a much
		// easier bot-detection signal to a WAF than the same requests spread apart.
		this.fetchScores();
		setTimeout(() => this.fetchFavorites(), 800);
		setTimeout(() => {
			this._standingsOnlyUpdate = false;
			this.fetchStandings();
		}, 1600);
	},

	scheduleRefresh () {
		const scheduleNext = () => {
			const jitter = Math.floor(Math.random() * 5000);
			const msUntilNextMinute = 60000 - (Date.now() % 60000) + jitter;
			setTimeout(() => {
				this.runStaggeredRefresh();
				scheduleNext();
			}, msUntilNextMinute);
		};
		scheduleNext();
	}
});
