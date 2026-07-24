const NodeHelper = require("node_helper");
const Log = require("logger");

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

	async fetchScores (payload) {
		const { sport, league, date, top25, requestId } = payload;
		const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${date}`;

		try {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const data = await response.json();
			let games = this.parseGames(data, sport, league);

			// TEMP TEST: force the first baseball game into a bases-loaded, 2-out state so the
			// situation indicator can be checked visually without waiting for a live game. Remove
			// this block once verified.
			if (sport === "baseball" && games.length > 0) {
				games[0].state = "in";
				games[0].detail = "Bot 7th";
				games[0].situation = { type: "baseball", outs: 2, onFirst: true, onSecond: true, onThird: true };
			}

			if (top25) {
				games = games.filter((g) => g.homeRank <= 25 || g.awayRank <= 25);
			}
			games.sort((a, b) =>{
				if (a.state === "in" && b.state !== "in") return -1;
				if (a.state !== "in" && b.state === "in") return 1;
				return new Date(a.eventDate) - new Date(b.eventDate);
			});
			this.sendSocketNotification("SCORES_DATA", { games, requestId });
		} catch (error) {
			Log.error(`${this.name}: Error fetching scores from ${url}:`, error.message);
			this.sendSocketNotification("SCORES_ERROR", { message: error.message, requestId });
		}
	},

	async fetchFavorites (payload) {
		const { date, favorites, requestId } = payload;

		const leagueMap = {};
		for (const fav of favorites) {
			const key = `${fav.sport}/${fav.league}`;
			if (!leagueMap[key]) {
				leagueMap[key] = { sport: fav.sport, league: fav.league, teams: [] };
			}
			leagueMap[key].teams.push(fav.team.toLowerCase());
		}

		const allGames = [];
		const fetches = Object.values(leagueMap).map(async ({ sport, league, teams }) => {
			const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${date}`;
			try {
				const response = await fetch(url);
				if (!response.ok) return;
				const data = await response.json();
				const games = this.parseGames(data, sport, league);

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

		// TEMP TEST: inject a synthetic live NFL favorite game (real games don't start until
		// August) so the football situation indicator and favorites styling can be checked
		// visually. Remove this block once verified.
		allGames.unshift({
			id: "test-fav-nfl",
			sport: "football",
			league: "nfl",
			url: "",
			homeRank: 99,
			awayRank: 99,
			homeTeam: { name: "Chicago Bears", abbreviation: "CHI", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/chi.png", score: "17", rank: null },
			awayTeam: { name: "Green Bay Packers", abbreviation: "GB", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/gb.png", score: "14", rank: null },
			state: "in",
			detail: "Q3 8:42",
			eventDate: "",
			situation: { type: "football", text: "3rd & 2 at CHI 45", possessionIsHome: true, possessionIsAway: false },
			favoriteIsHome: true,
			favoriteIsAway: false
		});

		this.sendSocketNotification("FAVORITES_DATA", { games: allGames, requestId });
	},

	async fetchStandings (payload) {
		const { sport, league, top25, view, requestId } = payload;

		try {
			if (top25) {
				const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/rankings`;
				const response = await fetch(url);
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
				this.sendSocketNotification("STANDINGS_DATA", {
					isRankings: true,
					groups: [{ name: poll?.name || "Rankings", teams }],
					requestId
				});
				return;
			}

			const level = view === "division" ? 3 : 2;
			const url = `https://site.api.espn.com/apis/v2/sports/${sport}/${league}/standings?level=${level}`;
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const data = await response.json();
			const groups = this.collectStandingsGroups(data);
			this.sendSocketNotification("STANDINGS_DATA", { isRankings: false, groups, requestId });
		} catch (error) {
			Log.error(`${this.name}: Error fetching standings:`, error.message);
			this.sendSocketNotification("STANDINGS_ERROR", { message: error.message, requestId });
		}
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
	}
});
