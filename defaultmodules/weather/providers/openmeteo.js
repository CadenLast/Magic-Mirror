const Log = require("logger");
const HTTPFetcher = require("#http_fetcher");

// https://www.bigdatacloud.com/docs/api/free-reverse-geocode-to-city-api
const GEOCODE_BASE = "https://api.bigdatacloud.net/data/reverse-geocode-client";
const OPEN_METEO_BASE = "https://api.open-meteo.com/v1";

/**
 * Server-side weather provider for Open-Meteo
 * see https://open-meteo.com/
 */
class OpenMeteoProvider {
	// https://open-meteo.com/en/docs
	hourlyParams = [
		"temperature_2m",
		"relativehumidity_2m",
		"dewpoint_2m",
		"apparent_temperature",
		"pressure_msl",
		"surface_pressure",
		"cloudcover",
		"cloudcover_low",
		"cloudcover_mid",
		"cloudcover_high",
		"windspeed_10m",
		"windspeed_80m",
		"windspeed_120m",
		"windspeed_180m",
		"winddirection_10m",
		"winddirection_80m",
		"winddirection_120m",
		"winddirection_180m",
		"windgusts_10m",
		"shortwave_radiation",
		"direct_radiation",
		"direct_normal_irradiance",
		"diffuse_radiation",
		"vapor_pressure_deficit",
		"cape",
		"evapotranspiration",
		"et0_fao_evapotranspiration",
		"precipitation",
		"snowfall",
		"precipitation_probability",
		"rain",
		"showers",
		"weathercode",
		"snow_depth",
		"freezinglevel_height",
		"visibility",
		"soil_temperature_0cm",
		"soil_temperature_6cm",
		"soil_temperature_18cm",
		"soil_temperature_54cm",
		"soil_moisture_0_1cm",
		"soil_moisture_1_3cm",
		"soil_moisture_3_9cm",
		"soil_moisture_9_27cm",
		"soil_moisture_27_81cm",
		"uv_index",
		"uv_index_clear_sky",
		"is_day",
		"terrestrial_radiation",
		"terrestrial_radiation_instant",
		"shortwave_radiation_instant",
		"diffuse_radiation_instant",
		"direct_radiation_instant",
		"direct_normal_irradiance_instant"
	];

	dailyParams = [
		"temperature_2m_max",
		"temperature_2m_min",
		"apparent_temperature_min",
		"apparent_temperature_max",
		"precipitation_sum",
		"rain_sum",
		"showers_sum",
		"snowfall_sum",
		"precipitation_hours",
		"weathercode",
		"sunrise",
		"sunset",
		"windspeed_10m_max",
		"windgusts_10m_max",
		"winddirection_10m_dominant",
		"shortwave_radiation_sum",
		"uv_index_max",
		"et0_fao_evapotranspiration"
	];

	constructor (config) {
		this.config = {
			apiBase: OPEN_METEO_BASE,
			lat: 0,
			lon: 0,
			pastDays: 0,
			type: "current",
			maxNumberOfDays: 5,
			updateInterval: 10 * 60 * 1000,
			...config
		};

		this.locationName = null;
		this.fetcher = null;
		this.onDataCallback = null;
		this.onErrorCallback = null;
		// Resolved lazily and cached once found; api.weather.gov is US-only, so this
		// stays null (and enrichment silently no-ops) for other locations.
		this.observationStationId = null;
	}

	async initialize () {
		await this.#fetchLocation();
		this.#initializeFetcher();
	}

	/**
	 * Set callbacks for data/error events
	 * @param {(data: object) => void} onData - Called with weather data
	 * @param {(error: object) => void} onError - Called with error info
	 */
	setCallbacks (onData, onError) {
		this.onDataCallback = onData;
		this.onErrorCallback = onError;
	}

	/**
	 * Start periodic fetching
	 */
	start () {
		if (this.fetcher) {
			this.fetcher.startPeriodicFetch();
		}
	}

	/**
	 * Stop periodic fetching
	 */
	stop () {
		if (this.fetcher) {
			this.fetcher.clearTimer();
		}
	}

	async #fetchLocation () {
		const url = `${GEOCODE_BASE}?latitude=${this.config.lat}&longitude=${this.config.lon}&localityLanguage=${this.config.lang || "en"}`;

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 10000);

			const response = await fetch(url, { signal: controller.signal });
			clearTimeout(timeoutId);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const data = await response.json();
			if (data && data.city) {
				this.locationName = `${data.city}, ${data.principalSubdivisionCode}`;
			}
		} catch (error) {
			Log.debug("[openmeteo] Could not load location data:", error.message);
		}
	}

	#initializeFetcher () {
		const url = this.#getUrl();

		this.fetcher = new HTTPFetcher(url, {
			reloadInterval: this.config.updateInterval,
			headers: { "Cache-Control": "no-cache" },
			logContext: "weatherprovider.openmeteo"
		});

		this.fetcher.on("response", async (response) => {
			try {
				const data = await response.json();
				await this.#handleResponse(data);
			} catch (error) {
				Log.error("[openmeteo] Failed to parse JSON:", error);
				if (this.onErrorCallback) {
					this.onErrorCallback({
						message: "Failed to parse API response",
						translationKey: "MODULE_ERROR_UNSPECIFIED"
					});
				}
			}
		});

		this.fetcher.on("error", (errorInfo) => {
			if (this.onErrorCallback) {
				this.onErrorCallback(errorInfo);
			}
		});
	}

	async #handleResponse (data) {
		const parsedData = this.#parseWeatherApiResponse(data);

		if (!parsedData) {
			if (this.onErrorCallback) {
				this.onErrorCallback({
					message: "Invalid API response",
					translationKey: "MODULE_ERROR_UNSPECIFIED"
				});
			}
			return;
		}

		try {
			let weatherData;
			switch (this.config.type) {
				case "current":
					weatherData = this.#generateWeatherDayFromCurrentWeather(parsedData);
					break;
				case "forecast":
				case "daily": {
					const observedPastPrecip = await this.#fetchObservedPastPrecip(parsedData);
					weatherData = this.#generateWeatherObjectsFromForecast(parsedData, observedPastPrecip);
					break;
				}
				case "hourly":
					weatherData = this.#generateWeatherObjectsFromHourly(parsedData);
					break;
				default:
					Log.error(`[openmeteo] Unknown type: ${this.config.type}`);
					throw new Error(`Unknown weather type: ${this.config.type}`);
			}

			if (weatherData && this.onDataCallback) {
				this.onDataCallback(weatherData);
			}
		} catch (error) {
			Log.error("[openmeteo] Error processing weather data:", error);
			if (this.onErrorCallback) {
				this.onErrorCallback({
					message: error.message,
					translationKey: "MODULE_ERROR_UNSPECIFIED"
				});
			}
		}
	}

	// Open-Meteo's past_days precipitation is model output, not an observation, and can
	// be badly wrong for localized rain events (verified against KIKV station data for
	// this project's coordinates: Open-Meteo reported 0mm on a day the station measured
	// ~27mm before midnight). For US locations, replace it with real NWS station totals.
	async #fetchObservedPastPrecip (parsedData) {
		const pastDayCount = this.config.pastDays;
		const days = parsedData.daily;

		if (!pastDayCount || !days || days.length <= pastDayCount) {
			return null;
		}

		try {
			if (!this.observationStationId) {
				this.observationStationId = await this.#resolveObservationStation();
				if (!this.observationStationId) {
					return null;
				}
			}

			const start = days[0].time;
			const end = days[pastDayCount].time; // local midnight of "today" - exclusive upper bound
			const url = `https://api.weather.gov/stations/${this.observationStationId}/observations?start=${start.toISOString()}&end=${end.toISOString()}`;
			const response = await this.#fetchNws(url);
			if (!response) {
				return null;
			}

			const observations = (await response.json()).features ?? [];
			const dailyTotals = new Array(pastDayCount).fill(null);
			const dailyHasObservation = new Array(pastDayCount).fill(false);

			for (const feature of observations) {
				const props = feature.properties;
				if (!props?.timestamp) continue;

				const obsTime = new Date(props.timestamp);
				const dayIndex = days.findIndex((day, i) => i < pastDayCount && obsTime >= day.time && obsTime < days[i + 1].time);
				if (dayIndex === -1) continue;

				dailyHasObservation[dayIndex] = true;
				const amount = props.precipitationLastHour?.value;
				if (amount != null) {
					dailyTotals[dayIndex] = (dailyTotals[dayIndex] ?? 0) + amount;
				}
			}

			// A day the station reported observations for, but none carried precipitation,
			// genuinely had none - only fall back to Open-Meteo's model value for days with
			// no observations at all (e.g. a station outage).
			for (let i = 0; i < pastDayCount; i++) {
				if (dailyHasObservation[i] && dailyTotals[i] === null) {
					dailyTotals[i] = 0;
				}
			}

			return dailyTotals;
		} catch (error) {
			Log.debug("[openmeteo] Could not fetch observed precipitation from NWS:", error.message);
			return null;
		}
	}

	async #resolveObservationStation () {
		const pointsResponse = await this.#fetchNws(`https://api.weather.gov/points/${this.config.lat},${this.config.lon}`);
		if (!pointsResponse) return null;

		const stationsUrl = (await pointsResponse.json()).properties?.observationStations;
		if (!stationsUrl) return null;

		const stationsResponse = await this.#fetchNws(stationsUrl);
		if (!stationsResponse) return null;

		const stationsData = await stationsResponse.json();
		return stationsData.features?.[0]?.properties?.stationIdentifier ?? null;
	}

	async #fetchNws (url) {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 15000);
		try {
			const response = await fetch(url, {
				signal: controller.signal,
				headers: { "User-Agent": "MagicMirror", Accept: "application/geo+json" }
			});
			return response.ok ? response : null;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	#getQueryParameters () {
		let maxNumberOfDays = this.config.maxNumberOfDays;

		if (this.config.maxNumberOfDays !== undefined && !isNaN(parseFloat(this.config.maxNumberOfDays))) {
			const maxEntriesLimit = ["daily", "forecast"].includes(this.config.type) ? 7 : this.config.type === "hourly" ? 48 : 0;
			const daysFactor = ["daily", "forecast"].includes(this.config.type) ? 1 : this.config.type === "hourly" ? 24 : 0;
			const maxEntries = Math.max(1, Math.min(Math.round(parseFloat(this.config.maxNumberOfDays)) * daysFactor, maxEntriesLimit));
			maxNumberOfDays = Math.ceil(maxEntries / Math.max(1, daysFactor));
		}

		const params = {
			latitude: this.config.lat,
			longitude: this.config.lon,
			timeformat: "unixtime",
			timezone: "auto",
			past_days: this.config.pastDays ?? 0,
			daily: this.dailyParams,
			hourly: this.hourlyParams,
			temperature_unit: "celsius",
			windspeed_unit: "ms",
			precipitation_unit: "mm"
		};

		switch (this.config.type) {
			case "hourly":
			case "daily":
			case "forecast":
				params.forecast_days = maxNumberOfDays + 1; // Open-Meteo counts today as day 1, so maxNumberOfDays=5 needs forecast_days=6
				break;
			case "current":
				params.current_weather = true;
				params.forecast_days = 1;
				break;
			default:
				return "";
		}

		return Object.keys(params)
			.filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== "")
			.map((key) => {
				switch (key) {
					case "hourly":
					case "daily":
						return `${encodeURIComponent(key)}=${params[key].join(",")}`;
					default:
						return `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`;
				}
			})
			.join("&");
	}

	#getUrl () {
		return `${this.config.apiBase}/forecast?${this.#getQueryParameters()}`;
	}

	#transposeDataMatrix (data) {
		return data.time.map((_, index) => Object.keys(data).reduce((row, key) => {
			const value = data[key][index];
			return {
				...row,
				// Convert Unix timestamps to Date objects
				[key]: ["time", "sunrise", "sunset"].includes(key) ? new Date(value * 1000) : value
			};
		}, {}));
	}

	#parseWeatherApiResponse (data) {
		const validByType = {
			current: data.current_weather && data.current_weather.time,
			hourly: data.hourly && data.hourly.time && Array.isArray(data.hourly.time) && data.hourly.time.length > 0,
			daily: data.daily && data.daily.time && Array.isArray(data.daily.time) && data.daily.time.length > 0
		};

		const type = ["daily", "forecast"].includes(this.config.type) ? "daily" : this.config.type;

		if (!validByType[type]) return null;

		if (type === "current" && !validByType.daily && !validByType.hourly) {
			return null;
		}

		for (const key of ["hourly", "daily"]) {
			if (typeof data[key] === "object") {
				data[key] = this.#transposeDataMatrix(data[key]);
			}
		}

		if (data.current_weather) {
			data.current_weather.time = new Date(data.current_weather.time * 1000);
		}

		return data;
	}

	#convertWeatherType (weathercode, isDayTime) {
		const weatherConditions = {
			0: "clear",
			1: "mainly-clear",
			2: "partly-cloudy",
			3: "overcast",
			45: "fog",
			48: "depositing-rime-fog",
			51: "drizzle-light-intensity",
			53: "drizzle-moderate-intensity",
			55: "drizzle-dense-intensity",
			56: "freezing-drizzle-light-intensity",
			57: "freezing-drizzle-dense-intensity",
			61: "rain-slight-intensity",
			63: "rain-moderate-intensity",
			65: "rain-heavy-intensity",
			66: "freezing-rain-light-intensity",
			67: "freezing-rain-heavy-intensity",
			71: "snow-fall-slight-intensity",
			73: "snow-fall-moderate-intensity",
			75: "snow-fall-heavy-intensity",
			77: "snow-grains",
			80: "rain-showers-slight",
			81: "rain-showers-moderate",
			82: "rain-showers-violent",
			85: "snow-showers-slight",
			86: "snow-showers-heavy",
			95: "thunderstorm",
			96: "thunderstorm-slight-hail",
			99: "thunderstorm-heavy-hail"
		};

		if (!(weathercode in weatherConditions)) return null;

		const mappings = {
			clear: isDayTime ? "day-sunny" : "night-clear",
			"mainly-clear": isDayTime ? "day-cloudy" : "night-alt-cloudy",
			"partly-cloudy": isDayTime ? "day-cloudy" : "night-alt-cloudy",
			overcast: isDayTime ? "day-sunny-overcast" : "night-alt-partly-cloudy",
			fog: isDayTime ? "day-fog" : "night-fog",
			"depositing-rime-fog": isDayTime ? "day-fog" : "night-fog",
			"drizzle-light-intensity": isDayTime ? "day-sprinkle" : "night-sprinkle",
			"rain-slight-intensity": isDayTime ? "day-sprinkle" : "night-sprinkle",
			"rain-showers-slight": isDayTime ? "day-sprinkle" : "night-sprinkle",
			"drizzle-moderate-intensity": isDayTime ? "day-showers" : "night-showers",
			"rain-moderate-intensity": isDayTime ? "day-showers" : "night-showers",
			"rain-showers-moderate": isDayTime ? "day-showers" : "night-showers",
			"drizzle-dense-intensity": isDayTime ? "day-thunderstorm" : "night-thunderstorm",
			"rain-heavy-intensity": isDayTime ? "day-thunderstorm" : "night-thunderstorm",
			"rain-showers-violent": isDayTime ? "day-thunderstorm" : "night-thunderstorm",
			"freezing-rain-light-intensity": isDayTime ? "day-rain-mix" : "night-rain-mix",
			"freezing-drizzle-light-intensity": "snowflake-cold",
			"freezing-drizzle-dense-intensity": "snowflake-cold",
			"snow-grains": isDayTime ? "day-sleet" : "night-sleet",
			"snow-fall-slight-intensity": isDayTime ? "day-snow-wind" : "night-snow-wind",
			"snow-fall-moderate-intensity": isDayTime ? "day-snow-wind" : "night-snow-wind",
			"snow-fall-heavy-intensity": isDayTime ? "day-snow-thunderstorm" : "night-snow-thunderstorm",
			"freezing-rain-heavy-intensity": isDayTime ? "day-snow-thunderstorm" : "night-snow-thunderstorm",
			"snow-showers-slight": isDayTime ? "day-rain-mix" : "night-rain-mix",
			"snow-showers-heavy": isDayTime ? "day-rain-mix" : "night-rain-mix",
			thunderstorm: isDayTime ? "day-thunderstorm" : "night-thunderstorm",
			"thunderstorm-slight-hail": isDayTime ? "day-sleet" : "night-sleet",
			"thunderstorm-heavy-hail": isDayTime ? "day-sleet-storm" : "night-sleet-storm"
		};

		return mappings[weatherConditions[`${weathercode}`]] || "na";
	}

	#isDayTime (date, sunrise, sunset) {
		const time = date.getTime();
		return time >= sunrise.getTime() && time < sunset.getTime();
	}

	#generateWeatherDayFromCurrentWeather (parsedData) {
		// Basic current weather data
		const current = {
			date: parsedData.current_weather.time,
			windSpeed: parsedData.current_weather.windspeed,
			windFromDirection: parsedData.current_weather.winddirection,
			temperature: parsedData.current_weather.temperature,
			weatherType: this.#convertWeatherType(parsedData.current_weather.weathercode, true)
		};

		// Add hourly data if available
		if (parsedData.hourly) {
			// Open-Meteo updates current_weather every 15 min, but hourly entries only
			// exist at full hours — find the last entry at or before the current time.
			const currentMs = parsedData.current_weather.time.getTime();
			const hourlyIndex = parsedData.hourly.findLastIndex((hour) => hour.time.getTime() <= currentMs);
			const hourData = parsedData.hourly[Math.max(0, hourlyIndex)];
			current.humidity = hourData.relativehumidity_2m;
			current.feelsLikeTemp = hourData.apparent_temperature;
			current.rain = hourData.rain;
			current.snow = hourData.snowfall != null ? hourData.snowfall * 10 : null;
			current.precipitationAmount = hourData.precipitation;
			current.precipitationProbability = hourData.precipitation_probability;
			current.uvIndex = hourData.uv_index;
		}

		// Add daily data if available (after transpose, daily is array of objects)
		if (parsedData.daily && Array.isArray(parsedData.daily) && parsedData.daily[0]) {
			const today = parsedData.daily[0];
			if (today.sunrise) {
				current.sunrise = today.sunrise;
			}
			if (today.sunset) {
				current.sunset = today.sunset;
				// Update weatherType with correct day/night status
				if (current.sunrise && current.sunset) {
					current.weatherType = this.#convertWeatherType(
						parsedData.current_weather.weathercode,
						this.#isDayTime(parsedData.current_weather.time, current.sunrise, current.sunset)
					);
				}
			}
			if (today.temperature_2m_min !== undefined) {
				current.minTemperature = today.temperature_2m_min;
			}
			if (today.temperature_2m_max !== undefined) {
				current.maxTemperature = today.temperature_2m_max;
			}
		}

		return current;
	}

	#generateWeatherObjectsFromForecast (parsedData, observedPastPrecip) {
		return parsedData.daily.map((weather, index) => {
			const observed = observedPastPrecip?.[index];
			return {
				date: weather.time,
				windSpeed: weather.windspeed_10m_max,
				windFromDirection: weather.winddirection_10m_dominant,
				sunrise: weather.sunrise,
				sunset: weather.sunset,
				temperature: parseFloat((weather.temperature_2m_max + weather.temperature_2m_min) / 2),
				minTemperature: parseFloat(weather.temperature_2m_min),
				maxTemperature: parseFloat(weather.temperature_2m_max),
				weatherType: this.#convertWeatherType(weather.weathercode, true),
				rain: weather.rain_sum != null ? parseFloat(weather.rain_sum) : null,
				snow: weather.snowfall_sum != null ? parseFloat(weather.snowfall_sum * 10) : null,
				precipitationAmount: observed != null ? observed : (weather.precipitation_sum != null ? parseFloat(weather.precipitation_sum) : null),
				precipitationProbability: weather.precipitation_hours != null ? parseFloat(weather.precipitation_hours * 100 / 24) : null,
				uvIndex: weather.uv_index_max != null ? parseFloat(weather.uv_index_max) : null
			};
		});
	}

	#generateWeatherObjectsFromHourly (parsedData) {
		const hours = [];
		const now = new Date();

		const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
		parsedData.hourly.forEach((weather, i) => {
			if (weather.time <= oneHourAgo) {
				return;
			}

			// Calculate daily index with bounds check
			const h = Math.ceil((i + 1) / 24) - 1;
			const safeH = Math.max(0, Math.min(h, parsedData.daily.length - 1));
			const dailyData = parsedData.daily[safeH];

			const hourlyWeather = {
				date: weather.time,
				windSpeed: weather.windspeed_10m,
				windFromDirection: weather.winddirection_10m,
				sunrise: dailyData.sunrise,
				sunset: dailyData.sunset,
				temperature: parseFloat(weather.temperature_2m),
				feelsLikeTemp: weather.apparent_temperature != null ? parseFloat(weather.apparent_temperature) : null,
				minTemperature: parseFloat(dailyData.temperature_2m_min),
				maxTemperature: parseFloat(dailyData.temperature_2m_max),
				weatherType: this.#convertWeatherType(
					weather.weathercode,
					this.#isDayTime(weather.time, dailyData.sunrise, dailyData.sunset)
				),
				humidity: weather.relativehumidity_2m != null ? parseFloat(weather.relativehumidity_2m) : null,
				rain: weather.rain != null ? parseFloat(weather.rain) : null,
				snow: weather.snowfall != null ? parseFloat(weather.snowfall * 10) : null,
				precipitationAmount: weather.precipitation != null ? parseFloat(weather.precipitation) : null,
				precipitationProbability: weather.precipitation_probability != null ? parseFloat(weather.precipitation_probability) : null,
				uvIndex: weather.uv_index != null ? parseFloat(weather.uv_index) : null
			};

			hours.push(hourlyWeather);
		});

		return hours;
	}
}

module.exports = OpenMeteoProvider;
