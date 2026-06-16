let config = {
	address: "localhost",	// Address to listen on, can be:
							// - "localhost", "127.0.0.1", "::1" to listen on loopback interface
							// - another specific IPv4/6 to listen on a specific interface
							// - "0.0.0.0", "::" to listen on any interface
							// Default, when address config is left out or empty, is "localhost"
	port: 8080,
	basePath: "/",	// The URL path where MagicMirror² is hosted. If you are using a Reverse proxy
									// you must set the sub path here. basePath must end with a /
	ipWhitelist: ["127.0.0.1", "::ffff:127.0.0.1", "::1"],	// Set [] to allow all IP addresses
									// or add a specific IPv4 of 192.168.1.5 :
									// ["127.0.0.1", "::ffff:127.0.0.1", "::1", "::ffff:192.168.1.5"],
									// or IPv4 range of 192.168.3.0 --> 192.168.3.15 use CIDR format :
									// ["127.0.0.1", "::ffff:127.0.0.1", "::1", "::ffff:192.168.3.0/28"],

	useHttps: false,			// Support HTTPS or not, default "false" will use HTTP
	httpsPrivateKey: "",	// HTTPS private key path, only require when useHttps is true
	httpsCertificate: "",	// HTTPS Certificate path, only require when useHttps is true

	language: "en",
	locale: "en-US",   // this variable is provided as a consistent location
			   // it is currently only used by 3rd party modules. no MagicMirror code uses this value
			   // as we have no usage, we  have no constraints on what this field holds
			   // see https://en.wikipedia.org/wiki/Locale_(computer_software) for the possibilities

	logLevel: ["INFO", "LOG", "WARN", "ERROR"], // Add "DEBUG" for even more logging
	timeFormat: 12,
	units: "imperial",
	resetTimeout: 5 * 60 * 1000, // In milliseconds
	ignoreXOriginHeader: true,
	ignoreContentSecurityPolicy: true,
	cursorStyle: "${CURSOR_STYLE}",
	electronOptions: {
		x: 1728,
		y: 0,
		width: 1080,
		height: 1920,
		fullscreen: true
	},


	modules: [
		{
			module: "alert",
		},
		{
			module: "updatenotification",
			position: "top_bar"
		},
		{
			module: "clock",
			position: "top_left"
		},
		{
			module: "weather",
			config: {
				weatherProvider: "openmeteo",
				type: "forecast",
				lat: 41.7268,
				lon: -93.6043,
				maxNumberOfDays: 16,
				maxEntries: 16,
				pastDays: 7
			}
		},
		// {
		// 	module: "weather",
		// 	config: {
		// 		weatherProvider: "openmeteo",
		// 		type: "hourly",
		// 		lat: 41.7268,
		// 		lon: -93.6043
		// 	}
		// },
		{
			module: "MMM-HourlyWeather",
			position: "top_right",
			config: {
				hoursToShow: 12,
				timeFormat: 12
			}
		},
		// {
		// 	module: "MMM-Radar",
		// 	position: "top_left",
		// 	config: {
		// 		lat: 41.7268,
		// 		lon: -93.6043,
		// 		zoom: 6.5,
		// 		width: "480px",
		// 		height: "360px"
		// 	}
		// },
		{
			module: "MMM-WeekCalendar",
			position: "bottom_bar",
			config: {
				calendars: [
					{
						url: "${GOOGLE_CALENDAR_PRIVATE_URL}",
					},
					{
						url: "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics",
					}
				]
			}
		},
		{
			module: "MMM-PackageTracking",
			position: "top_right",
			header: "Packages",
			config: {
				gmail: {
					clientId: "${GMAIL_CLIENT_ID}",
					clientSecret: "${GMAIL_CLIENT_SECRET}",
				},
				refreshInterval: 30 * 60 * 1000,
				emailScanInterval: 15 * 60 * 1000,
				showDelivered: true,
				daysToShowDelivered: 30
			}
		},
		{
			module: "MMM-SportsScores",
			position: "top_left"
		},
		{
			module: "MMM-BalancedNews",
			position: "bottom_bar",
			config: {
				feeds: [
					{
						title: "ESPN",
						url: "https://www.espn.com/espn/rss/news",
					},
					{
						title: "Pitchfork",
						url: "https://pitchfork.com/feed/feed-news/rss",
					},
					{
						title: "TechCrunch",
						url: "https://techcrunch.com/feed"
					},
				],
				showSourceTitle: true,
				showPublishDate: false,
				broadcastNewsFeeds: true,
				broadcastNewsUpdates: true,
				maxPerFeed: 5,
				animationSpeed: 1000,
			}
		},
	]
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") { module.exports = config; }
