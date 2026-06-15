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
			if (top25) {
				games = games.filter((g) => g.homeRank <= 25 || g.awayRank <= 25);
			}
			games.sort((a, b) => new Date(a.eventDate) - new Date(b.eventDate));
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
		this.sendSocketNotification("FAVORITES_DATA", { games: allGames, requestId });
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
				state: status.state || "pre",
				detail: status.shortDetail || status.detail || "",
				eventDate: event.date || ""
			};
		}).filter(Boolean);
	}
});
