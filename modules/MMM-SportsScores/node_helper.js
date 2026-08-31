const NodeHelper = require("node_helper");
const Log = require("logger");

// A generic scraper-shaped request (Node's default fetch sends "User-Agent: node"
// and little else) is an easy flag for ESPN/Akamai's bot detection. These headers
// make the request look like it came from a real browser loading espn.com itself.
const ESPN_HEADERS = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
	Accept: "application/json, text/plain, */*",
	"Accept-Language": "en-US,en;q=0.9",
	Referer: "https://www.espn.com/",
	Origin: "https://www.espn.com"
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// MLB and NHL both publish their own free, key-less, official APIs, so those two
// sports don't need to go through ESPN's hidden (and Akamai-blockable) endpoint
// at all. Everything else still uses ESPN.
const NATIVE_PROVIDERS = {
	"baseball/mlb": "mlb",
	"hockey/nhl": "nhl"
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

	// Builds a site.api.espn.com URL, or - if an espnProxy is configured in
	// config.js - the equivalent URL through that proxy (a Cloudflare Worker,
	// typically) so the request comes from a different IP than this Pi's.
	buildEspnUrl (path, query, proxy) {
		const base = proxy && proxy.url ? `${proxy.url.replace(/\/$/, "")}/proxy` : "https://site.api.espn.com";
		const url = new URL(`${base}${path}`);
		for (const [key, value] of Object.entries(query || {})) {
			url.searchParams.set(key, value);
		}
		if (proxy && proxy.url && proxy.key) {
			url.searchParams.set("key", proxy.key);
		}
		return url.toString();
	},

	async fetchGamesForProvider (sport, league, date, top25, proxy) {
		const provider = this.getProvider(sport, league);
		if (provider === "mlb") {
			return this.fetchMlbGames(date);
		}
		if (provider === "nhl") {
			return this.fetchNhlGames(date);
		}
		return this.fetchEspnGames(sport, league, date, top25, proxy);
	},

	async fetchScores (payload) {
		const { sport, league, date, top25, espnProxy, requestId } = payload;

		try {
			const games = await this.fetchGamesForProvider(sport, league, date, top25, espnProxy);
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
		const { date, favorites, espnProxy, requestId } = payload;

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
				const games = await this.fetchGamesForProvider(sport, league, date, false, espnProxy);

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
		const provider = this.getProvider(sport, league);

		try {
			let result;
			if (provider === "mlb") {
				result = await this.fetchMlbStandings(view);
			} else if (provider === "nhl") {
				result = await this.fetchNhlStandings(view);
			} else {
				result = await this.fetchEspnStandings(sport, league, top25, view, espnProxy);
			}
			this.sendSocketNotification("STANDINGS_DATA", { ...result, requestId });
		} catch (error) {
			Log.error(`${this.name}: Error fetching standings:`, error.message);
			this.sendSocketNotification("STANDINGS_ERROR", { message: error.message, requestId });
		}
	},

	// ---------------------------------------------------------------------
	// ESPN (NFL, NBA, NCAAF, NCAAB)
	// ---------------------------------------------------------------------

	async fetchEspnGames (sport, league, date, top25, proxy) {
		const url = this.buildEspnUrl(`/apis/site/v2/sports/${sport}/${league}/scoreboard`, { dates: date }, proxy);
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
			const url = this.buildEspnUrl(`/apis/site/v2/sports/${sport}/${league}/rankings`, {}, proxy);
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
		const url = this.buildEspnUrl(`/apis/v2/sports/${sport}/${league}/standings`, { level }, proxy);
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
			seed: statsByName.playoffSeed || "",
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
