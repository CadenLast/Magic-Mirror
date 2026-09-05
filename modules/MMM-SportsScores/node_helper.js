const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const NodeHelper = require("node_helper");
const Log = require("logger");

// Downloaded team logos are cached here instead of re-fetching from ESPN's/
// CFBD's CDN on every render - MagicMirror serves any file under a module's
// own directory automatically, so no custom serving route is needed. Not
// committed to git (see .gitignore) since these are downloaded binary
// assets, not source.
const LOGO_CACHE_DIR = path.join(__dirname, "cache", "logos");

// A generic scraper-shaped request (Node's default fetch sends "User-Agent: node"
// and little else) is an easy flag for bot detection on small athletics sites, so
// this sends a browser-looking User-Agent instead - used by the Hawkeyes/Sidearm
// RSS fetches below. Deliberately NOT sending Accept/Accept-Language/Referer/Origin
// alongside it - confirmed via direct testing that this specific combination
// (without the matching sec-fetch-*/sec-ch-ua headers a real browser would also
// send) gets an empty response on at least one real network, while User-Agent
// alone - or paired with just one of those headers - works reliably.
const BROWSER_HEADERS = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// MLB and NHL both publish their own free, key-less, official APIs. NFL/NBA use
// balldontlie, NCAAF/NCAAB use the college-teams-aggregate/AP-poll providers
// below - see getGameProvider/getStandingsProvider. Nothing in this module calls
// ESPN at all anymore.
const NATIVE_PROVIDERS = {
	"baseball/mlb": "mlb",
	"hockey/nhl": "nhl"
};

// balldontlie.io - a real licensed sports data API with a well-behaved, published
// rate limit (not adversarial bot mitigation) - covers game/score data for these
// leagues when a config.balldontlieKeys[league] API key is provided. Its
// dedicated standings endpoint needs a paid tier, but standings are computed
// locally from its free-tier season game results instead (see
// fetchBalldontlieStandings below), so ESPN isn't needed for these two
// leagues at all anymore.
const BALLDONTLIE_LEAGUE_PATHS = {
	nfl: "nfl",
	nba: "nba"
};

// A full NBA season is ~1300 games (13+ paginated requests just to compute
// standings once), so this is cached well past a single refresh cycle - an
// hour is already far more often than win/loss records actually change.
const BALLDONTLIE_STANDINGS_TTL_MS = 60 * 60 * 1000;

// NCAAF/NCAAB "standings" are actually the AP Top 25 poll (see
// fetchApPollStandings below) via CollegeFootballData.com/
// CollegeBasketballData.com, both leagues sharing one CFBD API key. Polls
// only publish weekly, so this is cached well past a single refresh cycle.
const AP_POLL_LEAGUES = new Set(["college-football", "mens-college-basketball"]);

// The NCAAF/NCAAB tabs show the union of the specifically-tracked college
// teams' games (same RSS/API sources as their favorites) instead of a real
// league-wide feed - there's no reliable free source for that at all, which
// is the whole reason those teams are handled individually in the first
// place. This fully removes ESPN from the picture for these two leagues.
const COLLEGE_TEAMS_AGGREGATE_LEAGUES = new Set(["college-football", "mens-college-basketball"]);
const AP_POLL_TTL_MS = 60 * 60 * 1000;

// Games/standings already refresh on their own minute-based cycle, so
// re-fetching the exact same query more often than that (e.g. rapid
// back-and-forth day-clicking, or a sport-switch bouncing back to a tab
// checked seconds ago) just burns rate-limit budget for no fresher data -
// short enough to not meaningfully delay a genuinely live score update.
const GAMES_FRESHNESS_TTL_MS = 45 * 1000;
const CFBD_TEAMS_TTL_MS = 24 * 60 * 60 * 1000;

// balldontlie's published free-tier limit is 5 requests/min per key. This is a
// hard cap on OUR OWN usage, enforced globally per API key value across every
// feature (games, favorites, standings background refresh) - not per-feature
// spacing, which could still add up past the real limit if multiple features
// share a key. Capped below the real limit as safety margin.
const BALLDONTLIE_MAX_REQUESTS_PER_MINUTE = 4;

// Specific college teams with no reliable league-wide data source (NCAAF/NCAAB
// games generally aren't available for free - see the balldontlie standings
// section below) but whose own athletics department site has real, extractable
// schedule data. Two different site platforms, two different extraction
// methods - see fetchHawkeyesTeamSchedule/fetchNuxtTeamSchedule.
// Sidearm Sports (the CMS platform behind cyclones.com/unipanthers.com/
// gocreighton.com/godrakebulldogs.com) publishes a legacy but stable RSS
// calendar feed at a fixed path on every site, regardless of which frontend
// template generation that site is otherwise running - confirmed the same
// schema works identically across all four, including full-season history
// with final scores. sportId is school-specific (not a shared numbering
// scheme), found by scanning each site's feed until the channel title matched.
const COLLEGE_TEAM_SOURCES = {
	"football/Iowa": { type: "hawkeyes", scheduleId: 1196 },
	"football/Iowa State": { type: "sidearm-rss", host: "https://cyclones.com", sportId: 1 },
	"basketball/Iowa": { type: "hawkeyes", scheduleId: 1338 },
	"basketball/Iowa State": { type: "sidearm-rss", host: "https://cyclones.com", sportId: 4 },
	"basketball/Northern Iowa": { type: "sidearm-rss", host: "https://unipanthers.com", sportId: 3 },
	"basketball/Creighton": { type: "sidearm-rss", host: "https://gocreighton.com", sportId: 18 },
	"basketball/Drake": { type: "sidearm-rss", host: "https://godrakebulldogs.com", sportId: 5 }
};

// A team's full schedule barely changes once released (just game results
// filling in over the season), so this is cached for hours rather than
// re-fetched every refresh cycle - these are small athletics department
// sites, not a resourced API, and deserve a light touch.
const COLLEGE_TEAM_SCHEDULE_TTL_MS = 3 * 60 * 60 * 1000;

// These sources never report a live in-progress score - only "not yet
// played" or "final" - so the 3-hour TTL above only ever risks delaying how
// soon a FINAL result shows up (if the cache was populated before kickoff,
// the game could be over for up to 3 hours before the schedule gets
// refetched). Once today's game for a team is still unresolved, switch to a
// much shorter TTL so the final score shows up within about a minute of the
// source actually publishing it, matching this module's own refresh cadence.
const COLLEGE_TEAM_LIVE_TTL_MS = 60 * 1000;

// balldontlie doesn't include team logos, but ESPN's static logo CDN is just
// image assets (not an API endpoint), so it isn't affected by the reliability
// problems that ruled ESPN out for game/score data. It uses lowercase team
// abbreviations that match balldontlie's almost exactly - these two are the
// only exceptions, confirmed by testing every current NFL/NBA team directly.
const ESPN_LOGO_SLUG_OVERRIDES = {
	nba: { NOP: "no", UTA: "utah" }
};

// Iowa's primary logo is black, which disappears against this module's dark
// background. Both CFBD and ESPN's logo CDNs also publish a "dark" variant
// (gold Tigerhawk) meant for exactly this situation - use those instead.
const COLLEGE_TEAM_LOGO_OVERRIDES = {
	"college-football": { Iowa: "https://cdn.collegefootballdata.com/logos-dark/500/2294.png" },
	"mens-college-basketball": { Iowa: "https://a.espncdn.com/i/teamlogos/ncaa/500-dark/2294.png" }
};

const toIsoDate = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

module.exports = NodeHelper.create({
	start () {
		Log.log(`Starting node helper for: ${this.name}`);
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "FETCH_SCORES") {
			this.fetchScores(payload);
		} else if (notification === "FETCH_FAVORITES") {
			this.fetchFavorites(payload);
		} else if (notification === "FETCH_STANDINGS") {
			this.fetchStandings(payload);
		}
	},

	getProvider (sport, league) {
		return NATIVE_PROVIDERS[`${sport}/${league}`] || null;
	},

	// Games/scores prefer balldontlie over the default provider when a key is
	// configured for that league - games and standings are gated independently
	// on balldontlie's free tier (e.g. NFL/NBA standings need a paid tier, but
	// NCAAF/NCAAB standings are free even though their games aren't), so this
	// and getStandingsProvider below check different league maps.
	getGameProvider (sport, league, balldontlieKeys) {
		if (BALLDONTLIE_LEAGUE_PATHS[league] && balldontlieKeys && balldontlieKeys[league]) {
			return "balldontlie";
		}
		if (COLLEGE_TEAMS_AGGREGATE_LEAGUES.has(league)) {
			return "college-teams-aggregate";
		}
		return this.getProvider(sport, league);
	},

	getStandingsProvider (sport, league, cfbdKey, balldontlieKeys) {
		if (AP_POLL_LEAGUES.has(league) && cfbdKey) {
			return "ap-poll";
		}
		if (BALLDONTLIE_LEAGUE_PATHS[league] && balldontlieKeys && balldontlieKeys[league]) {
			return "balldontlie-standings";
		}
		return this.getProvider(sport, league);
	},

	// Downloads a logo image once and serves it from the module's own cache
	// directory afterward, instead of hitting the remote CDN on every render.
	// Returns the local (module-relative) URL on success, or the original
	// remote URL unchanged if the download fails, so a bad download degrades
	// to today's behavior rather than showing a broken image.
	async cacheLogo (url) {
		if (!url) {
			return "";
		}

		const ext = (url.match(/\.(png|jpe?g|svg|gif|webp)(?:$|\?)/i) || [, "png"])[1].toLowerCase();
		const filename = `${crypto.createHash("sha1").update(url).digest("hex")}.${ext}`;
		const filePath = path.join(LOGO_CACHE_DIR, filename);
		const publicUrl = `modules/MMM-SportsScores/cache/logos/${filename}`;

		if (fs.existsSync(filePath)) {
			return publicUrl;
		}

		try {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			fs.mkdirSync(LOGO_CACHE_DIR, { recursive: true });
			fs.writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
			return publicUrl;
		} catch (error) {
			Log.warn(`${this.name}: Failed to cache logo ${url}: ${error.message}`);
			return url;
		}
	},

	// Small athletics/schedule sites have an irreducible rate of transient
	// failures no amount of retrying fully eliminates. Rather than let one bad
	// refresh cycle wipe out a league's games/standings, fall back to the last
	// successful result for that exact query - a refresh showing
	// slightly-stale-but-correct data beats one showing nothing.
	async fetchGamesForProvider (sport, league, date, balldontlieKeys, collegeTeams, cfbdKey) {
		const cacheKey = `${sport}/${league}/${date}`;
		this.gamesCache = this.gamesCache || {};
		const cached = this.gamesCache[cacheKey];
		if (cached && Date.now() - cached.fetchedAt < GAMES_FRESHNESS_TTL_MS) {
			return cached.games;
		}

		try {
			const games = await this.fetchGamesForProviderUncached(sport, league, date, balldontlieKeys, collegeTeams, cfbdKey);
			this.gamesCache[cacheKey] = { games, fetchedAt: Date.now() };
			return games;
		} catch (error) {
			if (cached) {
				Log.warn(`${this.name}: Using cached games for ${sport}/${league} after fetch failure: ${error.message}`);
				return cached.games;
			}
			throw error;
		}
	},

	async fetchGamesForProviderUncached (sport, league, date, balldontlieKeys, collegeTeams, cfbdKey) {
		const provider = this.getGameProvider(sport, league, balldontlieKeys);
		if (provider === "mlb") {
			return this.fetchMlbGames(date);
		}
		if (provider === "nhl") {
			return this.fetchNhlGames(date);
		}
		if (provider === "balldontlie") {
			return this.fetchBalldontlieGames(sport, league, date, balldontlieKeys[league]);
		}
		if (provider === "college-teams-aggregate") {
			return this.fetchCollegeTeamsAggregateGames(sport, date, collegeTeams, cfbdKey);
		}
		throw new Error(`No data source configured for ${sport}/${league}`);
	},

	async fetchScores (payload) {
		const { sport, league, date, balldontlieKeys, collegeTeams, cfbdKey, requestId } = payload;

		try {
			const games = await this.fetchGamesForProvider(sport, league, date, balldontlieKeys, collegeTeams, cfbdKey);
			games.sort((a, b) => {
				if (a.state === "in" && b.state !== "in") return -1;
				if (a.state !== "in" && b.state === "in") return 1;
				return new Date(a.eventDate) - new Date(b.eventDate);
			});
			this.sendSocketNotification("SCORES_DATA", { games, requestId });
		} catch (error) {
			Log.error(`${this.name}: Error fetching scores for ${sport}/${league}:`, error.message);
			this.sendSocketNotification("SCORES_ERROR", { message: error.message, requestId });
		}
	},

	async fetchFavorites (payload) {
		const { date, favorites, collegeTeams, balldontlieKeys, cfbdKey, requestId } = payload;

		const leagueMap = {};
		for (const fav of favorites) {
			const key = `${fav.sport}/${fav.league}`;
			if (!leagueMap[key]) {
				leagueMap[key] = { sport: fav.sport, league: fav.league, teams: [] };
			}
			leagueMap[key].teams.push(fav.team.toLowerCase());
		}

		const allGames = [];
		// Stagger these instead of firing every league's request in the same instant -
		// a burst of simultaneous connections from one IP, every minute, is a much
		// easier bot-detection signal than the same requests spread out a bit.
		const fetches = Object.values(leagueMap).map(async ({ sport, league, teams }, index) => {
			await sleep(index * 400);
			try {
				const games = await this.fetchGamesForProvider(sport, league, date, balldontlieKeys, collegeTeams, cfbdKey);

				for (const game of games) {
					const homeName = game.homeTeam.name.toLowerCase();
					const awayName = game.awayTeam.name.toLowerCase();
					const homeMatch = teams.some((t) => homeName.includes(t));
					const awayMatch = teams.some((t) => awayName.includes(t));
					if (homeMatch || awayMatch) {
						game.favoriteIsHome = homeMatch;
						game.favoriteIsAway = awayMatch;
						allGames.push(game);
					}
				}
			} catch (error) {
				Log.error(`${this.name}: Error fetching favorites for ${sport}/${league}:`, error.message);
			}
		});

		const collegeGames = [];
		const collegeFetches = (collegeTeams || []).map(async ({ sport, team }, index) => {
			// Only worth staggering when a real fetch is about to happen - the
			// schedule cache lasts hours, so on every refresh/day-switch after
			// the first, this is almost always already cached and skipping the
			// artificial delay here is what actually matters for feeling snappy.
			this.collegeTeamCache = this.collegeTeamCache || {};
			const cached = this.collegeTeamCache[`${sport}/${team}`];
			const isCacheHit = cached && Date.now() - cached.fetchedAt < COLLEGE_TEAM_SCHEDULE_TTL_MS;
			if (!isCacheHit) {
				await sleep((Object.keys(leagueMap).length + index) * 400);
			}
			try {
				const game = await this.fetchCollegeTeamGameForDate(sport, team, date, cfbdKey);
				if (game) {
					collegeGames.push(game);
				}
			} catch (error) {
				Log.error(`${this.name}: Error fetching college team favorite for ${sport}/${team}:`, error.message);
			}
		});

		await Promise.all([...fetches, ...collegeFetches]);
		for (const sport of new Set((collegeTeams || []).map((t) => t.sport))) {
			const relevantTeams = collegeTeams.filter((t) => t.sport === sport);
			const bySport = collegeGames.filter((g) => g.sport === sport);
			const marked = this.markTrackedTeamGames(bySport, relevantTeams);
			allGames.push(...marked);
		}
		this.sendSocketNotification("FAVORITES_DATA", { games: this.dedupeGamesByMatchup(allGames), requestId });
	},

	async fetchStandings (payload) {
		const { sport, league, view, cfbdKey, balldontlieKeys, requestId } = payload;
		const cacheKey = `${sport}/${league}/${view}`;
		this.standingsCache = this.standingsCache || {};

		try {
			const result = await this.fetchStandingsUncached(sport, league, view, cfbdKey, balldontlieKeys);
			this.standingsCache[cacheKey] = result;
			this.sendSocketNotification("STANDINGS_DATA", { ...result, requestId });
		} catch (error) {
			if (this.standingsCache[cacheKey]) {
				Log.warn(`${this.name}: Using cached standings for ${sport}/${league} after fetch failure: ${error.message}`);
				this.sendSocketNotification("STANDINGS_DATA", { ...this.standingsCache[cacheKey], requestId });
				return;
			}
			Log.error(`${this.name}: Error fetching standings:`, error.message);
			this.sendSocketNotification("STANDINGS_ERROR", { message: error.message, requestId });
		}
	},

	async fetchStandingsUncached (sport, league, view, cfbdKey, balldontlieKeys) {
		const provider = this.getStandingsProvider(sport, league, cfbdKey, balldontlieKeys);
		if (provider === "balldontlie-standings") {
			return this.fetchBalldontlieStandings(league, balldontlieKeys[league], view);
		}
		if (provider === "mlb") {
			return this.fetchMlbStandings(view);
		}
		if (provider === "nhl") {
			return this.fetchNhlStandings(view);
		}
		if (provider === "ap-poll") {
			return this.fetchApPollStandings(league, cfbdKey);
		}
		throw new Error(`No data source configured for ${sport}/${league}`);
	},

	// ---------------------------------------------------------------------
	// NFL/NBA - balldontlie.io. A licensed commercial sports data API with a
	// real, published rate limit; its free tier scopes one API key to one
	// sport. Standings are computed locally from its games data (see
	// fetchBalldontlieStandings below) since its dedicated standings endpoint
	// needs a paid tier.
	// ---------------------------------------------------------------------

	espnLogoUrl (league, abbreviation) {
		const overrides = ESPN_LOGO_SLUG_OVERRIDES[league] || {};
		const slug = (overrides[abbreviation] || abbreviation).toLowerCase();
		return `https://a.espncdn.com/i/teamlogos/${league}/500/${slug}.png`;
	},

	// Hard caps OUR OWN request rate per API key value, globally across every
	// feature that uses balldontlie (games, favorites, standings background
	// refresh) - not per-feature spacing, which could still add up past the
	// real 5/min limit if multiple features happen to share a key. Every
	// balldontlie call goes through this rather than calling fetch() directly.
	async throttleBalldontlie (apiKey) {
		this.balldontlieRequestLog = this.balldontlieRequestLog || {};
		const now = Date.now();
		const recent = (this.balldontlieRequestLog[apiKey] || []).filter((t) => now - t < 60000);

		if (recent.length >= BALLDONTLIE_MAX_REQUESTS_PER_MINUTE) {
			const waitMs = 60000 - (now - recent[0]) + 250;
			Log.warn(`${this.name}: balldontlie request throttled - waiting ${Math.ceil(waitMs / 1000)}s to stay under ${BALLDONTLIE_MAX_REQUESTS_PER_MINUTE}/min`);
			await sleep(waitMs);
			return this.throttleBalldontlie(apiKey);
		}

		recent.push(Date.now());
		this.balldontlieRequestLog[apiKey] = recent;
	},

	async balldontlieFetch (apiKey, url) {
		await this.throttleBalldontlie(apiKey);
		let response = await fetch(url, { headers: { Authorization: apiKey } });
		if (response.status === 429) {
			// Shouldn't normally happen given the throttle above, but as a last
			// resort (e.g. the same key used elsewhere at the same time) wait out
			// a full window and retry once rather than just failing outright.
			await sleep(60000);
			response = await fetch(url, { headers: { Authorization: apiKey } });
		}
		return response;
	},

	async fetchBalldontlieGames (sport, league, date, apiKey) {
		const leaguePath = BALLDONTLIE_LEAGUE_PATHS[league];
		const url = `https://api.balldontlie.io/${leaguePath}/v1/games?dates[]=${toIsoDate(date)}`;
		const response = await this.balldontlieFetch(apiKey, url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json();
		return (data.data || []).map((game) => this.parseBalldontlieGame(game, sport, league));
	},

	// The in-app game popup renders in an iframe, and ESPN's CSP (frame-ancestors)
	// blocks being embedded from any non-ESPN origin, so an espn.com link never
	// actually shows anything there regardless of how correct it is. nfl.com has
	// no such restriction and its regular-season game URLs follow a verified,
	// predictable pattern; postseason uses a different scheme this doesn't try
	// to guess, so those fall back to the (still embeddable) general scores page.
	balldontlieGameUrl (league, game) {
		if (league === "nfl" && !game.postseason && game.home_team?.name && game.visitor_team?.name) {
			const away = game.visitor_team.name.toLowerCase();
			const home = game.home_team.name.toLowerCase();
			return `https://www.nfl.com/games/${away}-at-${home}-${game.season}-reg-${game.week}`;
		}
		if (league === "nfl") {
			return "https://www.nfl.com/scores";
		}
		return `https://www.espn.com/${league}/scoreboard`;
	},

	parseBalldontlieGame (game, sport, league) {
		const state = game.status_state === "scheduled" ? "pre" : game.status_state === "final" ? "post" : "in";

		const balldontlieTeam = (team, score) => ({
			name: team?.full_name || "TBD",
			abbreviation: team?.abbreviation || "TBD",
			logo: team?.abbreviation ? this.espnLogoUrl(league, team.abbreviation) : "",
			score: String(score ?? "0"),
			rank: null
		});

		return {
			id: String(game.id || ""),
			sport: sport || "",
			league: league || "",
			url: this.balldontlieGameUrl(league, game),
			homeRank: 99,
			awayRank: 99,
			homeTeam: balldontlieTeam(game.home_team, game.home_team_score),
			awayTeam: balldontlieTeam(game.visitor_team, game.visitor_team_score),
			state,
			detail: game.status || "",
			eventDate: (league === "nba" ? game.datetime : game.date) || "",
			situation: null
		};
	},

	// balldontlie's dedicated standings endpoint needs a paid tier, but its
	// free-tier games endpoint already includes each team's conference/
	// division right on every game, and returns a full season (not just one
	// day) when queried by season instead of by date - so standings can be
	// computed directly from the same regular-season game results instead of
	// depending on ESPN at all. Cached for an hour (BALLDONTLIE_STANDINGS_TTL_MS)
	// since a full NBA season is ~1300 games (13+ paginated requests) - not
	// something to redo on every refresh cycle, and win/loss records don't
	// change faster than that anyway.
	resolveBalldontlieSeason (league, now) {
		const month = now.getMonth() + 1;
		if (league === "nfl") {
			// Season named by the year it starts (Sept) - still "last" season's
			// number through the Feb Super Bowl, and defaults to the
			// just-completed season through the summer off-season.
			return month >= 8 ? now.getFullYear() : now.getFullYear() - 1;
		}
		// NBA: named by the year it starts (Oct) - "current" through the June
		// Finals, defaults to the just-completed season the rest of the summer.
		return month >= 10 ? now.getFullYear() : now.getFullYear() - 1;
	},

	async fetchBalldontlieTeamsLookup (league, apiKey) {
		this.balldontlieTeamsCache = this.balldontlieTeamsCache || {};
		const cached = this.balldontlieTeamsCache[league];
		if (cached && Date.now() - cached.fetchedAt < CFBD_TEAMS_TTL_MS) {
			return cached.teams;
		}
		const leaguePath = BALLDONTLIE_LEAGUE_PATHS[league];
		const response = await this.balldontlieFetch(apiKey, `https://api.balldontlie.io/${leaguePath}/v1/teams`);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json();
		const teams = data.data || [];
		this.balldontlieTeamsCache[league] = { teams, fetchedAt: Date.now() };
		return teams;
	},

	async fetchBalldontlieSeasonGames (league, apiKey, season) {
		const leaguePath = BALLDONTLIE_LEAGUE_PATHS[league];
		const games = [];
		let cursor = null;
		for (;;) {
			const url = `https://api.balldontlie.io/${leaguePath}/v1/games?seasons[]=${season}&per_page=100${cursor ? `&cursor=${cursor}` : ""}`;
			const response = await this.balldontlieFetch(apiKey, url);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const data = await response.json();
			games.push(...(data.data || []));
			if (!data.meta?.next_cursor) {
				break;
			}
			cursor = data.meta.next_cursor;
		}
		return games;
	},

	formatWinPct (wins, losses, ties) {
		const total = wins + losses + ties;
		if (total === 0) {
			return ".000";
		}
		const pct = (wins + ties * 0.5) / total;
		const display = pct.toFixed(3);
		return display.startsWith("0") ? display.slice(1) : display;
	},

	titleCase (word) {
		return word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : "";
	},

	computeBalldontlieTeamRecords (teams, games) {
		// balldontlie's /teams list includes defunct historical NBA franchises
		// and unrelated international/exhibition clubs alongside the 30 real
		// current teams - all of them with a blank (whitespace) conference,
		// which is the only reliable way to filter them out.
		const currentTeams = teams.filter((t) => (t.conference || "").trim());
		const byId = new Map(currentTeams.map((t) => [t.id, {
			id: t.id,
			name: t.full_name || t.name || "",
			abbreviation: t.abbreviation || "",
			conference: t.conference || "",
			division: this.titleCase(t.division || ""),
			wins: 0,
			losses: 0,
			ties: 0
		}]));

		// Postseason games never count toward regular-season standings.
		const finished = games.filter((g) => g.status_state === "final" && !g.postseason);
		for (const game of finished) {
			const home = byId.get(game.home_team?.id);
			const away = byId.get(game.visitor_team?.id);
			if (!home || !away) continue;
			if (game.home_team_score > game.visitor_team_score) {
				home.wins++;
				away.losses++;
			} else if (game.visitor_team_score > game.home_team_score) {
				away.wins++;
				home.losses++;
			} else {
				home.ties++;
				away.ties++;
			}
		}
		return [...byId.values()];
	},

	buildBalldontlieStandingsGroups (records, league, view) {
		const groupKey = (r) => (view === "division" ? `${r.conference} ${r.division}` : r.conference);

		const byGroup = new Map();
		for (const record of records) {
			const key = groupKey(record);
			if (!byGroup.has(key)) byGroup.set(key, []);
			byGroup.get(key).push(record);
		}

		const groups = [...byGroup.entries()].map(([name, groupRecords]) => {
			const sorted = [...groupRecords].sort((a, b) => {
				const aTotal = a.wins + a.losses + a.ties;
				const bTotal = b.wins + b.losses + b.ties;
				const aPct = aTotal ? (a.wins + a.ties * 0.5) / aTotal : 0;
				const bPct = bTotal ? (b.wins + b.ties * 0.5) / bTotal : 0;
				return bPct - aPct;
			});
			const leader = sorted[0];
			const teams = sorted.map((r, index) => ({
				seed: index + 1,
				name: r.name,
				abbreviation: r.abbreviation,
				logo: r.abbreviation ? this.espnLogoUrl(league, r.abbreviation) : "",
				record: r.ties > 0 ? `${r.wins}-${r.losses}-${r.ties}` : `${r.wins}-${r.losses}`,
				stat: this.formatWinPct(r.wins, r.losses, r.ties),
				gamesBehind: leader === r ? "-" : (((leader.wins - r.wins) + (r.losses - leader.losses)) / 2).toFixed(1)
			}));
			return { name, teams };
		});

		return groups;
	},

	async fetchBalldontlieStandings (league, apiKey, view) {
		this.balldontlieStandingsCache = this.balldontlieStandingsCache || {};
		const cached = this.balldontlieStandingsCache[league];
		let records;
		if (cached && Date.now() - cached.fetchedAt < BALLDONTLIE_STANDINGS_TTL_MS) {
			records = cached.records;
		} else {
			const season = this.resolveBalldontlieSeason(league, new Date());
			const [teams, games] = await Promise.all([
				this.fetchBalldontlieTeamsLookup(league, apiKey),
				this.fetchBalldontlieSeasonGames(league, apiKey, season)
			]);
			records = this.computeBalldontlieTeamRecords(teams, games);
			this.balldontlieStandingsCache[league] = { records, fetchedAt: Date.now() };
		}
		return { isRankings: false, groups: this.buildBalldontlieStandingsGroups(records, league, view) };
	},

	// ---------------------------------------------------------------------
	// NCAAF/NCAAB "standings" - the AP Top 25 poll, from CollegeFootballData.com
	// and its sister site CollegeBasketballData.com (same account/key, same
	// team behind both - confirmed the existing CFBD key works directly on
	// the basketball API too). Polls publish weekly and aren't live data, so
	// none of the concerns that ruled CFBD out for live scores apply here.
	// Replaced full conference-by-conference standings (previously via
	// balldontlie) with just the poll - a smaller, different dataset, but far
	// simpler and requested specifically over the full table.
	// ---------------------------------------------------------------------

	async fetchApPollStandings (league, apiKey) {
		const cacheKey = league;
		this.apPollCache = this.apPollCache || {};
		const cached = this.apPollCache[cacheKey];
		if (cached && Date.now() - cached.fetchedAt < AP_POLL_TTL_MS) {
			return { isRankings: true, groups: [{ name: "AP Top 25", teams: cached.teams }] };
		}

		const teams = league === "college-football"
			? await this.fetchCfbdFootballApPoll(apiKey)
			: await this.fetchCfbdBasketballApPoll(apiKey);

		this.apPollCache[cacheKey] = { teams, fetchedAt: Date.now() };
		return { isRankings: true, groups: [{ name: "AP Top 25", teams }] };
	},

	async fetchCfbdJson (url, apiKey) {
		const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return response.json();
	},

	// Team rosters/abbreviations/logos change essentially never within a
	// season, so this is cached far longer than the poll itself - a real
	// abbreviation (e.g. "OSU") instead of the full school name matters for
	// fitting the standings column's abbreviation slot, which is sized for
	// short codes.
	async fetchCfbdTeamsLookup (league, apiKey) {
		this.cfbdTeamsCache = this.cfbdTeamsCache || {};
		const cached = this.cfbdTeamsCache[league];
		if (cached && Date.now() - cached.fetchedAt < CFBD_TEAMS_TTL_MS) {
			return cached.lookup;
		}

		const url = league === "college-football"
			? `https://api.collegefootballdata.com/teams?year=${new Date().getFullYear()}`
			: "https://api.collegebasketballdata.com/teams";
		const teams = await this.fetchCfbdJson(url, apiKey);
		// Football's response includes real logo URLs directly; basketball's
		// doesn't, but its "sourceId" is ESPN's own numeric team ID (confirmed
		// by cross-referencing against ESPN's own scoreboard data directly -
		// Duke's sourceId and ESPN's team id both come out to 150), so ESPN's
		// static logo CDN (an image host, not an API - no reliability concerns
		// like the ones that ruled ESPN out for data) works from that.
		const logoOverrides = COLLEGE_TEAM_LOGO_OVERRIDES[league] || {};
		const lookup = new Map();
		for (const t of teams) {
			const logo = logoOverrides[t.school] || (league === "college-football"
				? (t.logos && t.logos[0]) || ""
				: (t.sourceId ? `https://a.espncdn.com/i/teamlogos/ncaa/500/${t.sourceId}.png` : ""));
			const entry = { abbreviation: t.abbreviation || t.school, logo };
			// Sidearm RSS/Hawkeyes opponent names are often shortened (e.g.
			// "Southeast Missouri" instead of CFBD's canonical "Southeast
			// Missouri State"), which would otherwise miss this lookup entirely
			// and fall back to the full name as its own "abbreviation". Football
			// publishes exactly this kind of shortened name as alternateNames;
			// basketball doesn't, but its displayName/shortDisplayName cover the
			// same gap.
			const keys = league === "college-football"
				? [t.school, ...(t.alternateNames || [])]
				: [t.school, t.displayName, t.shortDisplayName];
			for (const key of keys) {
				if (key) lookup.set(key, entry);
			}
		}

		this.cfbdTeamsCache[league] = { lookup, fetchedAt: Date.now() };
		return lookup;
	},

	// CFBD groups football rankings by week, with every poll (AP, Coaches,
	// etc.) nested inside each week's entry.
	async fetchCfbdFootballApPoll (apiKey) {
		const year = new Date().getFullYear();
		const [data, teamsLookup] = await Promise.all([
			this.fetchCfbdJson(`https://api.collegefootballdata.com/rankings?year=${year}`, apiKey),
			this.fetchCfbdTeamsLookup("college-football", apiKey)
		]);
		if (!data.length) {
			throw new Error("No CFBD rankings data available");
		}
		const latestWeek = data.reduce((max, entry) => (entry.week > max.week ? entry : max), data[0]);
		const apPoll = (latestWeek.polls || []).find((p) => p.poll === "AP Top 25");
		if (!apPoll) {
			throw new Error("No AP Top 25 poll in latest CFBD week");
		}
		return Promise.all(apPoll.ranks.map(async (r) => {
			const team = teamsLookup.get(r.school);
			const logo = await this.cacheLogo(team?.logo);
			return { rank: r.rank, name: r.school, abbreviation: team?.abbreviation || r.school, logo, record: "" };
		}));
	},

	// CollegeBasketballData's /rankings returns a flat list of one row per
	// team per week per poll (not grouped like football's), and its "season"
	// is named by the year the season ENDS in (unlike football, which is
	// named by the year it starts) - since there's a real off-season gap
	// where neither the just-finished nor the next season has a poll yet,
	// this tries the season that should be "current" by month first and
	// falls back to the prior one if that's empty.
	async fetchCfbdBasketballApPoll (apiKey) {
		const teamsLookup = await this.fetchCfbdTeamsLookup("mens-college-basketball", apiKey);
		const now = new Date();
		const likelyCurrentSeason = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
		for (const season of [likelyCurrentSeason, likelyCurrentSeason - 1]) {
			const data = await this.fetchCfbdJson(`https://api.collegebasketballdata.com/rankings?season=${season}&pollType=ap`, apiKey);
			const ranked = data.filter((e) => e.ranking != null);
			if (ranked.length === 0) {
				continue;
			}
			const latestWeek = Math.max(...ranked.map((e) => e.week));
			const topTeams = ranked
				.filter((e) => e.week === latestWeek)
				.sort((a, b) => a.ranking - b.ranking);
			return Promise.all(topTeams.map(async (r) => {
				const team = teamsLookup.get(r.team);
				const logo = await this.cacheLogo(team?.logo);
				return { rank: r.ranking, name: r.team, abbreviation: team?.abbreviation || r.team, logo, record: "" };
			}));
		}
		throw new Error("No CFBD/CBBD AP poll data available for either candidate season");
	},

	// ---------------------------------------------------------------------
	// Specific college teams (Iowa, Iowa State, Northern Iowa, Creighton) -
	// pulled directly from their own athletics department sites, since
	// there's no reliable free league-wide source for NCAAF/NCAAB game data.
	// Two different site platforms need two different extraction approaches;
	// see COLLEGE_TEAM_SOURCES above for which team uses which.
	// ---------------------------------------------------------------------

	// When two tracked college teams play each other, both of their
	// schedules report the same real-world game independently, so it'd
	// otherwise show up twice - collapse anything with the same two
	// teams/sport/date down to one entry.
	dedupeGamesByMatchup (games) {
		const seen = new Set();
		return games.filter((game) => {
			const teams = [game.homeTeam.name, game.awayTeam.name].sort().join("|");
			const key = `${game.sport}|${teams}|${(game.eventDate || "").slice(0, 10)}`;
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
	},

	// Used as the actual "NCAAF"/"NCAAB" tab content instead of a real
	// league-wide feed - there's no reliable free source for that (the whole
	// reason these are per-team RSS/API sources in the first place), so this
	// just shows the union of whatever your specifically-tracked teams are
	// playing that day, same source as the college team favorites above.
	async fetchCollegeTeamsAggregateGames (sport, date, collegeTeams, cfbdKey) {
		const relevantTeams = (collegeTeams || []).filter((t) => t.sport === sport);
		const games = await Promise.all(relevantTeams.map((t) => this.fetchCollegeTeamGameForDate(t.sport, t.team, date, cfbdKey).catch((error) => {
			Log.error(`${this.name}: Error fetching ${t.sport}/${t.team} for the ${sport} tab:`, error.message);
			return null;
		})));
		const deduped = this.dedupeGamesByMatchup(games.filter(Boolean));
		return this.markTrackedTeamGames(deduped, relevantTeams);
	},

	// A game's favoriteIsHome/favoriteIsAway are set when it's first fetched,
	// from the perspective of whichever single team's schedule it came from -
	// when two tracked teams play each other, only that one side ends up
	// marked, even though the "opponent" is independently tracked too. This
	// re-derives both flags from the full tracked-team list instead, so a
	// matchup between two tracked teams correctly highlights both.
	markTrackedTeamGames (games, relevantTeams) {
		const trackedNames = new Set(relevantTeams.map((t) => t.team));
		return games.map((game) => ({
			...game,
			favoriteIsHome: trackedNames.has(game.homeTeam.name),
			favoriteIsAway: trackedNames.has(game.awayTeam.name)
		}));
	},

	hasUnresolvedGameToday (games) {
		const today = new Date().toISOString().slice(0, 10);
		return games.some((g) => (g.eventDate || "").slice(0, 10) === today && g.state !== "post");
	},

	async fetchCollegeTeamGameForDate (sport, team, date, cfbdKey) {
		const games = await this.fetchCollegeTeamSchedule(sport, team, cfbdKey);
		const target = toIsoDate(date);
		return games.find((g) => (g.eventDate || "").slice(0, 10) === target) || null;
	},

	async fetchCollegeTeamSchedule (sport, team, cfbdKey) {
		const key = `${sport}/${team}`;
		const source = COLLEGE_TEAM_SOURCES[key];
		if (!source) {
			return [];
		}

		this.collegeTeamCache = this.collegeTeamCache || {};
		const cached = this.collegeTeamCache[key];
		if (cached) {
			const ttl = this.hasUnresolvedGameToday(cached.games) ? COLLEGE_TEAM_LIVE_TTL_MS : COLLEGE_TEAM_SCHEDULE_TTL_MS;
			if (Date.now() - cached.fetchedAt < ttl) {
				return cached.games;
			}
		}

		try {
			// The AP poll's CFBD/CBBD teams lookup (real abbreviations + logos) is
			// reused here too, rather than falling back to full names - these
			// sources give full school names, not short codes, and this data is
			// already fetched and cached long-term for the AP poll anyway.
			const teamsLookup = cfbdKey ? await this.fetchCfbdTeamsLookup(sport === "football" ? "college-football" : "mens-college-basketball", cfbdKey).catch(() => null) : null;

			const games = source.type === "hawkeyes"
				? await this.fetchHawkeyesTeamSchedule(sport, team, source.scheduleId, teamsLookup)
				: await this.fetchSidearmRssSchedule(sport, team, source.host, source.sportId, teamsLookup);

			this.collegeTeamCache[key] = { games, fetchedAt: Date.now() };
			return games;
		} catch (error) {
			// A single small athletics site having a bad moment shouldn't make
			// that team's favorite silently vanish for this refresh cycle -
			// same cache-fallback pattern as fetchGamesForProvider below.
			if (cached) {
				Log.warn(`${this.name}: Using cached schedule for ${key} after fetch failure: ${error.message}`);
				return cached.games;
			}
			throw error;
		}
	},

	// Falls back to the name/logo already available from the schedule source
	// itself (which is always at least a full team name) if there's no CFBD
	// teams lookup at all, or that specific team isn't in it.
	async resolveCollegeTeamDisplay (teamsLookup, name, fallbackLogo) {
		const match = teamsLookup && teamsLookup.get(name);
		const logoUrl = match?.logo || fallbackLogo || "";
		const logo = logoUrl ? await this.cacheLogo(logoUrl) : "";
		return { abbreviation: match?.abbreviation || name, logo };
	},

	async fetchHawkeyesTeamSchedule (sport, team, scheduleId, teamsLookup) {
		const url = `https://hawkeyesports.com/website-api/schedule-events?filter[schedule_id]=${scheduleId}&sort=datetime&per_page=50&page=1`;
		const response = await fetch(url, { headers: BROWSER_HEADERS });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json();
		return Promise.all((data.data || []).map((event) => this.parseHawkeyesEvent(sport, team, event, teamsLookup)));
	},

	async parseHawkeyesEvent (sport, team, event, teamsLookup) {
		// This site hasn't shown a completed or live game yet to confirm the
		// exact status values for those (or any score fields) - confirmed by
		// testing that TBD/unconfirmed future games report status as null
		// rather than "as_scheduled", so anything not explicitly recognized as
		// final defaults to "pre" rather than "in" (a live game briefly
		// showing as not-yet-started is a smaller, less confusing error than
		// a game weeks out showing as live).
		const state = (event.status || "").toLowerCase().includes("final") ? "post" : "pre";
		const isHome = event.venue_type === "home";
		const opponentName = event.opponent_school_name || event.opponent_name || "TBD";

		const [teamDisplay, opponentDisplay] = await Promise.all([
			this.resolveCollegeTeamDisplay(teamsLookup, team, ""),
			this.resolveCollegeTeamDisplay(teamsLookup, opponentName, "")
		]);
		const teamSide = { name: team, ...teamDisplay, score: "0", rank: null };
		const opponentSide = { name: opponentName, ...opponentDisplay, score: "0", rank: null };

		return {
			id: String(event.id || ""),
			sport: sport || "",
			league: "",
			url: event.box_score_url || "https://hawkeyesports.com/",
			homeRank: 99,
			awayRank: 99,
			homeTeam: isHome ? teamSide : opponentSide,
			awayTeam: isHome ? opponentSide : teamSide,
			state,
			detail: event.status_text || (state === "pre" ? "Scheduled" : ""),
			eventDate: event.datetime || "",
			situation: null,
			favoriteIsHome: isHome,
			favoriteIsAway: !isHome
		};
	},

	async fetchSidearmRssSchedule (sport, team, host, sportId, teamsLookup) {
		const url = `${host}/calendar.ashx/calendar.rss?sport_id=${sportId}`;
		const response = await fetch(url, { headers: BROWSER_HEADERS });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const xml = await response.text();
		return Promise.all(this.parseSidearmRssItems(xml).map((item) => this.parseSidearmRssGame(sport, team, host, item, teamsLookup)));
	},

	// Sidearm's RSS calendar feed uses a small set of flat, non-nested
	// namespaced tags per <item> - simple enough that pulling in a full XML
	// parser dependency isn't worth it for this.
	parseSidearmRssItems (xml) {
		const field = (block, tag) => {
			// No wildcard after the tag name - some of these tags (s:opponent /
			// s:opponentlogo) are prefixes of each other, and a "match any
			// attributes" wildcard there would let this slide into the wrong tag.
			const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
			return m ? this.decodeXmlEntities(m[1].trim()) : "";
		};
		const items = [];
		const itemRegex = /<item>([\s\S]*?)<\/item>/g;
		let match;
		while ((match = itemRegex.exec(xml))) {
			const block = match[1];
			items.push({
				title: field(block, "title"),
				description: field(block, "description"),
				startDate: field(block, "ev:startdate"),
				localStartDate: field(block, "s:localstartdate"),
				teamLogo: field(block, "s:teamlogo"),
				opponentLogo: field(block, "s:opponentlogo"),
				opponent: field(block, "s:opponent"),
				gameId: field(block, "s:gameid")
			});
		}
		return items;
	},

	decodeXmlEntities (text) {
		return text
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, "\"")
			.replace(/&#39;/g, "'");
	},

	async parseSidearmRssGame (sport, team, host, item, teamsLookup) {
		// Completed games get a "[W]"/"[L]"/"[T]" prefix on the title and a
		// "W 77-71"-style result line in the description; anything without
		// that prefix is still upcoming - there's no separate live-game
		// state observed in this feed at all, so it can only ever report
		// "pre" or "post".
		const resultMatch = item.title.match(/\[(W|L|T)\]/);
		const state = resultMatch ? "post" : "pre";
		const isHome = / vs /.test(item.title);

		let teamScore = "0";
		let opponentScore = "0";
		if (resultMatch) {
			const scoreMatch = item.description.match(/[WLT]\s+(\d+)-(\d+)/);
			if (scoreMatch) {
				teamScore = scoreMatch[1];
				opponentScore = scoreMatch[2];
			}
		}

		const opponentName = item.opponent || "TBD";
		const [teamDisplay, opponentDisplay] = await Promise.all([
			this.resolveCollegeTeamDisplay(teamsLookup, team, item.teamLogo),
			this.resolveCollegeTeamDisplay(teamsLookup, opponentName, item.opponentLogo)
		]);
		const teamSide = { name: team, ...teamDisplay, score: teamScore, rank: null };
		const opponentSide = { name: opponentName, ...opponentDisplay, score: opponentScore, rank: null };

		return {
			id: item.gameId || "",
			sport: sport || "",
			league: "",
			url: item.gameId ? `${host}/calendar.aspx?game_id=${item.gameId}` : host,
			homeRank: 99,
			awayRank: 99,
			homeTeam: isHome ? teamSide : opponentSide,
			awayTeam: isHome ? opponentSide : teamSide,
			state,
			detail: state === "post" ? "Final" : "",
			// localStartDate has no timezone suffix (matches the local venue
			// date), used here for date-matching against the requested day;
			// startDate is genuine UTC, used for display time elsewhere.
			eventDate: item.startDate.replace(/\.\d+Z$/, "Z") || item.localStartDate,
			situation: null,
			favoriteIsHome: isHome,
			favoriteIsAway: !isHome
		};
	},

	// ---------------------------------------------------------------------
	// MLB - MLB Advanced Media's own public Stats API (statsapi.mlb.com).
	// Free, no key, official league infrastructure.
	// ---------------------------------------------------------------------

	async fetchMlbGames (date) {
		const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${toIsoDate(date)}&hydrate=linescore,team`;
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json();
		const games = [];
		for (const day of data.dates || []) {
			for (const game of day.games || []) {
				games.push(this.parseMlbGame(game));
			}
		}
		return games;
	},

	parseMlbGame (game) {
		const abstractState = game.status?.abstractGameState || "Preview";
		const state = abstractState === "Live" ? "in" : abstractState === "Final" ? "post" : "pre";
		const away = game.teams?.away || {};
		const home = game.teams?.home || {};

		let detail = game.status?.detailedState || "";
		if (state === "in" && game.linescore) {
			const inningState = game.linescore.inningState === "Bottom" ? "Bot" : (game.linescore.inningState || "");
			detail = `${inningState} ${game.linescore.currentInningOrdinal || ""}`.trim() || detail;
		}

		const mlbTeam = (side) => ({
			name: side.team?.name || "TBD",
			abbreviation: side.team?.abbreviation || "TBD",
			logo: side.team?.id ? `https://www.mlbstatic.com/team-logos/${side.team.id}.svg` : "",
			score: String(side.score ?? "0"),
			rank: null
		});

		return {
			id: String(game.gamePk || ""),
			sport: "baseball",
			league: "mlb",
			url: game.gamePk ? `https://www.mlb.com/gameday/${game.gamePk}` : "https://www.mlb.com/scores",
			homeRank: 99,
			awayRank: 99,
			homeTeam: mlbTeam(home),
			awayTeam: mlbTeam(away),
			state,
			detail,
			eventDate: game.gameDate || "",
			situation: state === "in" ? this.parseMlbSituation(game.linescore) : null
		};
	},

	parseMlbSituation (linescore) {
		if (!linescore) return null;
		const offense = linescore.offense || {};
		const hasBaserunnerInfo = "first" in offense || "second" in offense || "third" in offense;
		if (typeof linescore.outs !== "number" && !hasBaserunnerInfo) return null;
		return {
			type: "baseball",
			outs: typeof linescore.outs === "number" ? linescore.outs : null,
			onFirst: !!offense.first,
			onSecond: !!offense.second,
			onThird: !!offense.third
		};
	},

	async fetchMlbStandings (view) {
		const season = new Date().getFullYear();
		const url = `https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${season}&hydrate=team`;
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json();
		const records = data.records || [];

		if (view === "division") {
			const groups = records.map((record) => ({
				name: record.teamRecords[0]?.team?.division?.name || "Division",
				teams: record.teamRecords.map((tr) => this.parseMlbStandingsEntry(tr, "division"))
			}));
			return { isRankings: false, groups };
		}

		// League view: merge every division within the same league and re-sort by
		// win percentage, since MLB's API only groups by division directly.
		const byLeague = new Map();
		for (const record of records) {
			const leagueName = record.teamRecords[0]?.team?.league?.name || "League";
			if (!byLeague.has(leagueName)) byLeague.set(leagueName, []);
			byLeague.get(leagueName).push(...record.teamRecords);
		}
		const groups = [...byLeague.entries()].map(([name, teamRecords]) => {
			const sorted = [...teamRecords].sort((a, b) => (parseFloat(b.winningPercentage) || 0) - (parseFloat(a.winningPercentage) || 0));
			return { name, teams: sorted.map((tr) => this.parseMlbStandingsEntry(tr, "league")) };
		});
		return { isRankings: false, groups };
	},

	parseMlbStandingsEntry (teamRecord, view) {
		const wins = teamRecord.wins ?? 0;
		const losses = teamRecord.losses ?? 0;
		return {
			seed: (view === "division" ? teamRecord.divisionRank : teamRecord.leagueRank) || "",
			name: teamRecord.team?.name || "",
			abbreviation: teamRecord.team?.abbreviation || "",
			logo: teamRecord.team?.id ? `https://www.mlbstatic.com/team-logos/${teamRecord.team.id}.svg` : "",
			record: `${wins}-${losses}`,
			stat: teamRecord.winningPercentage || "",
			gamesBehind: (view === "division" ? teamRecord.gamesBack : teamRecord.leagueGamesBack) || "-"
		};
	},

	// ---------------------------------------------------------------------
	// NHL - the NHL's own public live API (api-web.nhle.com).
	// Free, no key, official league infrastructure.
	// ---------------------------------------------------------------------

	async fetchNhlGames (date) {
		const isoDate = toIsoDate(date);
		const url = `https://api-web.nhle.com/v1/schedule/${isoDate}`;
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json();
		const week = (data.gameWeek || []).find((w) => w.date === isoDate);
		return (week?.games || []).map((game) => this.parseNhlGame(game));
	},

	parseNhlGame (game) {
		const gameState = game.gameState || "FUT";
		const state = (gameState === "LIVE" || gameState === "CRIT") ? "in" : (gameState === "OFF" || gameState === "FINAL") ? "post" : "pre";
		const away = game.awayTeam || {};
		const home = game.homeTeam || {};
		const teamLabel = (t) => `${t.placeName?.default || ""} ${t.commonName?.default || ""}`.trim();

		let detail = "";
		if (state === "post") {
			const periodType = game.periodDescriptor?.periodType;
			detail = periodType && periodType !== "REG" ? `Final/${periodType}` : "Final";
		} else if (state === "in") {
			const num = game.periodDescriptor?.number;
			detail = num ? `Period ${num}` : "Live";
		}

		const nhlTeam = (side) => ({
			name: teamLabel(side) || "TBD",
			abbreviation: side.abbrev || "TBD",
			logo: side.logo || "",
			score: String(side.score ?? "0"),
			rank: null
		});

		return {
			id: String(game.id || ""),
			sport: "hockey",
			league: "nhl",
			url: game.id ? `https://www.nhl.com/gamecenter/${game.id}` : "https://www.nhl.com/scores",
			homeRank: 99,
			awayRank: 99,
			homeTeam: nhlTeam(home),
			awayTeam: nhlTeam(away),
			state,
			detail,
			eventDate: game.startTimeUTC || "",
			situation: null
		};
	},

	async fetchNhlStandings (view) {
		const url = "https://api-web.nhle.com/v1/standings/now";
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json();
		const teams = data.standings || [];

		const groupKey = view === "division" ? "divisionName" : "conferenceName";
		const seedKey = view === "division" ? "divisionSequence" : "conferenceSequence";

		const byGroup = new Map();
		for (const team of teams) {
			const name = team[groupKey] || "League";
			if (!byGroup.has(name)) byGroup.set(name, []);
			byGroup.get(name).push(team);
		}

		const groups = [...byGroup.entries()].map(([name, groupTeams]) => ({
			name,
			teams: groupTeams
				.sort((a, b) => (a[seedKey] ?? 99) - (b[seedKey] ?? 99))
				.map((team) => this.parseNhlStandingsEntry(team, seedKey))
		}));
		return { isRankings: false, groups };
	},

	parseNhlStandingsEntry (team, seedKey) {
		const wins = team.wins ?? 0;
		const losses = team.losses ?? 0;
		const otLosses = team.otLosses ?? 0;
		return {
			seed: team[seedKey] ?? "",
			name: team.teamName?.default || "",
			abbreviation: team.teamAbbrev?.default || "",
			logo: team.teamLogo || "",
			record: `${wins}-${losses}-${otLosses}`,
			stat: `${team.points ?? 0} PTS`,
			// NHL standings are points-based, not games-behind - null (not
			// "-") tells the frontend to hide the column instead of rendering
			// a dash for every team.
			gamesBehind: null
		};
	}
});
