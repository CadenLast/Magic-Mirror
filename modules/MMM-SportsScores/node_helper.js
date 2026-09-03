const { execFile } = require("child_process");
const util = require("util");
const NodeHelper = require("node_helper");
const Log = require("logger");

const execFileAsync = util.promisify(execFile);

// A generic scraper-shaped request (Node's default fetch sends "User-Agent: node"
// and little else) is an easy flag for ESPN/Akamai's bot detection, so this sends
// a browser-looking User-Agent. Deliberately NOT sending Accept/Accept-Language/
// Referer/Origin alongside it - confirmed via direct testing that this specific
// combination (without the matching sec-fetch-*/sec-ch-ua headers a real browser
// would also send) gets an empty response on at least one real network, while
// User-Agent alone - or paired with just one of those headers - works reliably.
const ESPN_HEADERS = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// MLB and NHL both publish their own free, key-less, official APIs, so those two
// sports don't need to go through ESPN at all. The rest use ESPN's public
// website data (cdn.espn.com "core" pages) rather than the hidden mobile API
// (site.api.espn.com), since Akamai blocks that one but not this one - and,
// unlike the free tier of alternatives such as TheSportsDB (which silently
// omits most of a day's games), it's actually complete when it works.
const NATIVE_PROVIDERS = {
	"baseball/mlb": "mlb",
	"hockey/nhl": "nhl",
	"football/nfl": "espn-core",
	"basketball/nba": "espn-core",
	"football/college-football": "espn-core",
	"basketball/mens-college-basketball": "espn-core"
};

// NFL and college football are scheduled in weeks, and the core scoreboard page
// ignores a plain "dates=" query - it only respects an explicit year/seasontype/week
// combination, so browsing to a specific date means walking the season's calendar
// (returned alongside the current week's data) to find which week contains it.
// NBA and college basketball are scheduled daily, and "dates=YYYYMMDD" works as-is.
const WEEK_BASED_LEAGUES = new Set(["nfl", "college-football"]);

// The core rankings ("AP Top 25" style poll) page only exists for college football;
// college basketball has no equivalent page under cdn.espn.com.
const RANKINGS_SUPPORTED_LEAGUES = new Set(["college-football"]);

// balldontlie.io - a real licensed sports data API with a well-behaved, published
// rate limit (not adversarial bot mitigation) - covers game/score data for these
// leagues when a config.balldontlieKeys[league] API key is provided. Its free tier
// doesn't include standings, so standings for these leagues still come from ESPN's
// core pages regardless of whether a balldontlie key is configured.
const BALLDONTLIE_LEAGUE_PATHS = {
	nfl: "nfl",
	nba: "nba"
};

// balldontlie doesn't include team logos, but ESPN's static logo CDN is just
// image assets (not an API endpoint), so it isn't affected by the reliability
// problems that ruled ESPN out for game/score data. It uses lowercase team
// abbreviations that match balldontlie's almost exactly - these two are the
// only exceptions, confirmed by testing every current NFL/NBA team directly.
const ESPN_LOGO_SLUG_OVERRIDES = {
	nba: { NOP: "no", UTA: "utah" }
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
		return NATIVE_PROVIDERS[`${sport}/${league}`] || "espn";
	},

	// Games/scores prefer balldontlie over the default provider when a key is
	// configured for that league - standings always use getProvider above,
	// regardless, since balldontlie's free tier doesn't include standings.
	getGameProvider (sport, league, balldontlieKeys) {
		if (BALLDONTLIE_LEAGUE_PATHS[league] && balldontlieKeys && balldontlieKeys[league]) {
			return "balldontlie";
		}
		return this.getProvider(sport, league);
	},

	// Builds an ESPN URL against the given host, or - if an espnProxy is
	// configured in config.js - the equivalent URL through that proxy (a
	// Cloudflare Worker, typically) so the request comes from a different IP
	// than this Pi's.
	buildEspnUrl (host, path, query, proxy) {
		const base = proxy && proxy.url ? `${proxy.url.replace(/\/$/, "")}/proxy` : host;
		const url = new URL(`${base}${path}`);
		for (const [key, value] of Object.entries(query || {})) {
			url.searchParams.set(key, value);
		}
		if (proxy && proxy.url && proxy.key) {
			url.searchParams.set("key", proxy.key);
		}
		return url.toString();
	},

	// ESPN's core pages have an irreducible rate of transient failures no amount
	// of retrying fully eliminates. Rather than let one bad refresh cycle wipe
	// out a league's games/standings, fall back to the last successful result
	// for that exact query - a refresh showing slightly-stale-but-correct data
	// beats one showing nothing.
	async fetchGamesForProvider (sport, league, date, top25, proxy, balldontlieKeys) {
		const cacheKey = `${sport}/${league}/${date}/${top25}`;
		this.gamesCache = this.gamesCache || {};
		try {
			const games = await this.fetchGamesForProviderUncached(sport, league, date, top25, proxy, balldontlieKeys);
			this.gamesCache[cacheKey] = games;
			return games;
		} catch (error) {
			if (this.gamesCache[cacheKey]) {
				Log.warn(`${this.name}: Using cached games for ${sport}/${league} after fetch failure: ${error.message}`);
				return this.gamesCache[cacheKey];
			}
			throw error;
		}
	},

	async fetchGamesForProviderUncached (sport, league, date, top25, proxy, balldontlieKeys) {
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
		if (provider === "espn-core") {
			return this.fetchEspnCoreGames(sport, league, date, top25, proxy);
		}
		return this.fetchEspnGames(sport, league, date, top25, proxy);
	},

	async fetchScores (payload) {
		const { sport, league, date, top25, espnProxy, balldontlieKeys, requestId } = payload;

		try {
			const games = await this.fetchGamesForProvider(sport, league, date, top25, espnProxy, balldontlieKeys);
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
		const { date, favorites, espnProxy, balldontlieKeys, requestId } = payload;

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
				const games = await this.fetchGamesForProvider(sport, league, date, false, espnProxy, balldontlieKeys);

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

		await Promise.all(fetches);
		this.sendSocketNotification("FAVORITES_DATA", { games: allGames, requestId });
	},

	async fetchStandings (payload) {
		const { sport, league, top25, view, espnProxy, requestId } = payload;
		const cacheKey = `${sport}/${league}/${top25}/${view}`;
		this.standingsCache = this.standingsCache || {};

		try {
			const result = await this.fetchStandingsUncached(sport, league, top25, view, espnProxy);
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

	async fetchStandingsUncached (sport, league, top25, view, espnProxy) {
		const provider = this.getProvider(sport, league);
		if (provider === "mlb") {
			return this.fetchMlbStandings(view);
		}
		if (provider === "nhl") {
			return this.fetchNhlStandings(view);
		}
		if (provider === "espn-core") {
			return this.fetchEspnCoreStandings(league, top25, view, espnProxy);
		}
		return this.fetchEspnStandings(sport, league, top25, view, espnProxy);
	},

	// ---------------------------------------------------------------------
	// ESPN (NFL, NBA, NCAAF, NCAAB)
	// ---------------------------------------------------------------------

	async fetchEspnGames (sport, league, date, top25, proxy) {
		const url = this.buildEspnUrl("https://site.api.espn.com", `/apis/site/v2/sports/${sport}/${league}/scoreboard`, { dates: date }, proxy);
		const response = await fetch(url, { headers: ESPN_HEADERS });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json();
		let games = this.parseGames(data, sport, league);
		if (top25) {
			games = games.filter((g) => g.homeRank <= 25 || g.awayRank <= 25);
		}
		return games;
	},

	async fetchEspnStandings (sport, league, top25, view, proxy) {
		if (top25) {
			const url = this.buildEspnUrl("https://site.api.espn.com", `/apis/site/v2/sports/${sport}/${league}/rankings`, {}, proxy);
			const response = await fetch(url, { headers: ESPN_HEADERS });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const data = await response.json();
			const poll = (data.rankings || [])[0];
			const teams = (poll?.ranks || []).map((r) => ({
				rank: r.current,
				name: r.team?.displayName || `${r.team?.location || ""} ${r.team?.name || ""}`.trim(),
				abbreviation: r.team?.abbreviation || "",
				logo: r.team?.logos?.[0]?.href || "",
				record: r.recordSummary || ""
			}));
			return { isRankings: true, groups: [{ name: poll?.name || "Rankings", teams }] };
		}

		const level = view === "division" ? 3 : 2;
		const url = this.buildEspnUrl("https://site.api.espn.com", `/apis/v2/sports/${sport}/${league}/standings`, { level }, proxy);
		const response = await fetch(url, { headers: ESPN_HEADERS });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json();
		const groups = this.collectStandingsGroups(data);
		return { isRankings: false, groups };
	},

	collectStandingsGroups (node, groups = []) {
		if (node.standings && node.standings.entries) {
			groups.push({
				name: node.name || node.abbreviation || "",
				teams: node.standings.entries.map((entry) => this.parseStandingsEntry(entry))
			});
		}
		if (node.children) {
			for (const child of node.children) {
				this.collectStandingsGroups(child, groups);
			}
		}
		return groups;
	},

	parseStandingsEntry (entry) {
		const statsByName = {};
		for (const s of entry.stats || []) {
			statsByName[s.name] = s.displayValue;
		}

		const wins = statsByName.wins || "0";
		const losses = statsByName.losses || "0";
		const ties = parseInt(statsByName.ties) || 0;
		const otLosses = statsByName.otLosses;

		let record;
		let stat;
		if (otLosses !== undefined) {
			record = `${wins}-${losses}-${otLosses}`;
			stat = statsByName.points ? `${statsByName.points} PTS` : (statsByName.winPercent || "");
		} else if (ties > 0) {
			record = `${wins}-${losses}-${ties}`;
			stat = statsByName.winPercent || "";
		} else {
			record = `${wins}-${losses}`;
			stat = statsByName.winPercent || "";
		}

		return {
			seed: statsByName.playoffSeed || entry.team?.seed || "",
			name: entry.team?.displayName || "",
			abbreviation: entry.team?.abbreviation || "",
			logo: entry.team?.logos?.[0]?.href || "",
			record,
			stat,
			gamesBehind: statsByName.gamesBehind || "-"
		};
	},

	parseGames (data, sport, league) {
		if (!data.events) return [];

		return data.events.map((event) => {
			const competition = event.competitions?.[0];
			if (!competition) return null;

			const competitors = competition.competitors || [];
			const homeComp = competitors.find((c) => c.homeAway === "home") || competitors[0];
			const awayComp = competitors.find((c) => c.homeAway === "away") || competitors[1];

			if (!homeComp || !awayComp) return null;

			const status = event.status?.type || {};
			const summaryLink = event.links?.find((l) => l.text === "Summary" || l.text === "Gamecast" || l.text === "Box Score");
			const gameUrl = summaryLink?.href || `https://www.espn.com/${sport}/game/_/gameId/${event.id}`;

			const homeRank = homeComp.curatedRank?.current || 99;
			const awayRank = awayComp.curatedRank?.current || 99;

			const state = status.state || "pre";

			return {
				id: event.id || "",
				sport: sport || "",
				league: league || "",
				url: gameUrl,
				homeRank,
				awayRank,
				homeTeam: {
					name: homeComp.team?.displayName || "TBD",
					abbreviation: homeComp.team?.abbreviation || "TBD",
					logo: homeComp.team?.logo || "",
					score: homeComp.score || "0",
					rank: homeRank <= 25 ? homeRank : null
				},
				awayTeam: {
					name: awayComp.team?.displayName || "TBD",
					abbreviation: awayComp.team?.abbreviation || "TBD",
					logo: awayComp.team?.logo || "",
					score: awayComp.score || "0",
					rank: awayRank <= 25 ? awayRank : null
				},
				state,
				detail: status.shortDetail || status.detail || "",
				eventDate: event.date || "",
				situation: state === "in" ? this.parseSituation(competition, sport, homeComp, awayComp) : null
			};
		}).filter(Boolean);
	},

	parseSituation (competition, sport, homeComp, awayComp) {
		const sit = competition.situation;
		if (!sit) return null;

		if (sport === "baseball") {
			return {
				type: "baseball",
				outs: typeof sit.outs === "number" ? sit.outs : null,
				onFirst: !!sit.onFirst,
				onSecond: !!sit.onSecond,
				onThird: !!sit.onThird
			};
		}

		if (sport === "football") {
			const text = sit.shortDownDistanceText || sit.downDistanceText || sit.possessionText || "";
			if (!text) return null;
			return {
				type: "football",
				text,
				possessionIsHome: !!sit.possession && sit.possession === homeComp.team?.id,
				possessionIsAway: !!sit.possession && sit.possession === awayComp.team?.id
			};
		}

		return null;
	},

	// ---------------------------------------------------------------------
	// ESPN core pages (NFL, NBA, NCAAF, NCAAB) - the public website-rendering
	// API at cdn.espn.com, used instead of the hidden mobile API above because
	// Akamai blocks that one from residential/datacenter IPs but not this one.
	// ---------------------------------------------------------------------

	// cdn.espn.com's Akamai bot-mitigation regularly answers fetch()-based
	// requests (both Node's own fetch and Cloudflare Workers') with an empty
	// 202 "hold on" response, but never a plain curl process - curl's TLS/HTTP
	// fingerprint apparently isn't in the bucket it's suspicious of. So every
	// core-page request shells out to curl instead of using fetch directly.
	async curlGetJson (url) {
		const args = ["-s", "--compressed", "--max-time", "15"];
		for (const [key, value] of Object.entries(ESPN_HEADERS)) {
			args.push("-H", `${key}: ${value}`);
		}
		args.push(url);
		const { stdout } = await execFileAsync("curl", args, { maxBuffer: 20 * 1024 * 1024 });
		return JSON.parse(stdout);
	},

	async fetchEspnCoreJson (url) {
		const maxAttempts = 5;
		for (let attempt = 1; ; attempt++) {
			try {
				return await this.curlGetJson(url);
			} catch (error) {
				if (attempt >= maxAttempts) {
					throw error;
				}
				await sleep(750 * attempt);
			}
		}
	},

	async fetchEspnCoreGames (sport, league, date, top25, proxy) {
		const host = "https://cdn.espn.com";
		let events;
		if (WEEK_BASED_LEAGUES.has(league)) {
			events = await this.fetchEspnCoreWeekEvents(host, league, date, proxy);
		} else {
			const url = this.buildEspnUrl(host, `/core/${league}/scoreboard`, { xhr: 1, limit: 200, dates: date }, proxy);
			const data = await this.fetchEspnCoreJson(url);
			events = data.content?.sbData?.events || [];
		}
		let games = this.parseGames({ events }, sport, league);
		if (top25) {
			games = games.filter((g) => g.homeRank <= 25 || g.awayRank <= 25);
		}
		return games;
	},

	// Week-based leagues ignore "dates=" entirely, so getting a specific date's
	// games means fetching the current week first (which also returns the
	// season's full calendar), finding which week actually contains that date,
	// and - if it isn't the week already fetched - fetching that week directly
	// via explicit year/seasontype/week params.
	async fetchEspnCoreWeekEvents (host, league, date, proxy) {
		const baseUrl = this.buildEspnUrl(host, `/core/${league}/scoreboard`, { xhr: 1, limit: 200 }, proxy);
		const baseData = await this.fetchEspnCoreJson(baseUrl);
		const current = baseData.content?.dateParams || {};
		const calendar = baseData.content?.calendar || [];
		const target = date ? this.resolveCoreWeek(calendar, date, current) : null;

		if (!target || (String(target.week) === String(current.week) && String(target.seasontype) === String(current.seasontype))) {
			// Either no specific date was requested, or it falls in the week we
			// already have - and if the date is outside this season's calendar
			// entirely (far past/future), fall back to the current week rather
			// than fetching a different season.
			return baseData.content?.sbData?.events || [];
		}

		const url = this.buildEspnUrl(host, `/core/${league}/scoreboard`, { xhr: 1, limit: 200, year: target.year, seasontype: target.seasontype, week: target.week }, proxy);
		const data = await this.fetchEspnCoreJson(url);
		return data.content?.sbData?.events || [];
	},

	// Finds which calendar entry (week) contains the target date. The calendar
	// is a list of season-phase groups (Preseason/Regular Season/Postseason),
	// each with per-week entries carrying a startDate/endDate range.
	resolveCoreWeek (calendar, date, current) {
		const target = new Date(`${toIsoDate(date)}T12:00:00Z`);
		for (const group of calendar) {
			for (const entry of group.entries || []) {
				if (target >= new Date(entry.startDate) && target <= new Date(entry.endDate)) {
					return { year: current.year, seasontype: group.value, week: entry.value };
				}
			}
		}
		return null;
	},

	async fetchEspnCoreStandings (league, top25, view, proxy) {
		const host = "https://cdn.espn.com";

		if (top25) {
			if (!RANKINGS_SUPPORTED_LEAGUES.has(league)) {
				throw new Error(`Top 25 rankings aren't available for ${league} right now`);
			}
			const url = this.buildEspnUrl(host, `/core/${league}/rankings`, { xhr: 1 }, proxy);
			const data = await this.fetchEspnCoreJson(url);
			const poll = (data.content?.data?.rankings || [])[0];
			const teams = (poll?.ranks || []).map((r) => ({
				rank: r.rank,
				name: r.team_display_name || "",
				abbreviation: r.team_abbreviation || "",
				logo: r.team_logo || "",
				record: r.formatted_record || ""
			}));
			return { isRankings: true, groups: [{ name: poll?.name || "Rankings", teams }] };
		}

		const url = this.buildEspnUrl(host, `/core/${league}/standings`, { xhr: 1 }, proxy);
		const data = await this.fetchEspnCoreJson(url);
		const groups = this.collectCoreStandingsGroups(data.content?.standings || {}, view);
		return { isRankings: false, groups };
	},

	// The core standings page nests groups arbitrarily deep (conference -> division,
	// or sometimes just one level) instead of the hidden API's fixed children/level
	// shape, so this walks down to the leaf group(s) that actually hold team entries.
	collectCoreStandingsGroups (node, view) {
		const isLeaf = (n) => n.standings && n.standings.entries && (!n.groups || n.groups.length === 0);

		if (view === "division") {
			const groups = [];
			const walk = (n) => {
				if (isLeaf(n)) {
					groups.push({
						name: n.name || n.abbreviation || "",
						teams: n.standings.entries.map((entry) => this.parseStandingsEntry(entry))
					});
					return;
				}
				for (const child of n.groups || []) {
					walk(child);
				}
			};
			walk(node);
			return groups;
		}

		return (node.groups || []).map((conference) => {
			const entries = [];
			const collect = (n) => {
				if (isLeaf(n)) {
					entries.push(...n.standings.entries);
					return;
				}
				for (const child of n.groups || []) {
					collect(child);
				}
			};
			collect(conference);
			const parsed = entries.map((entry) => this.parseStandingsEntry(entry));
			parsed.sort((a, b) => (parseFloat(b.stat) || 0) - (parseFloat(a.stat) || 0));
			return { name: conference.name || conference.abbreviation || "", teams: parsed };
		});
	},

	// ---------------------------------------------------------------------
	// NFL/NBA - balldontlie.io. A licensed commercial sports data API with a
	// real, published rate limit; its free tier scopes one API key to one sport
	// and doesn't include standings, so standings still come from ESPN's core
	// pages regardless of whether a balldontlie key is configured.
	// ---------------------------------------------------------------------

	espnLogoUrl (league, abbreviation) {
		const overrides = ESPN_LOGO_SLUG_OVERRIDES[league] || {};
		const slug = (overrides[abbreviation] || abbreviation).toLowerCase();
		return `https://a.espncdn.com/i/teamlogos/${league}/500/${slug}.png`;
	},

	async fetchBalldontlieGames (sport, league, date, apiKey) {
		const leaguePath = BALLDONTLIE_LEAGUE_PATHS[league];
		const url = `https://api.balldontlie.io/${leaguePath}/v1/games?dates[]=${toIsoDate(date)}`;
		const response = await fetch(url, { headers: { Authorization: apiKey } });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json();
		return (data.data || []).map((game) => this.parseBalldontlieGame(game, sport, league));
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
			url: `https://www.espn.com/${league}/scoreboard`,
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
			gamesBehind: "-"
		};
	}
});
