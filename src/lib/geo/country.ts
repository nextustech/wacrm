/**
 * Offline country detection — no geo-IP service, no API calls, no cost.
 *
 * Three free signals, in order of reliability:
 *   1. a phone number's dial code      (WhatsApp, SMS, any contact with a phone)
 *   2. a browser locale's region tag   (live chat — "bn-BD" -> BD)
 *   3. an IANA timezone                (live chat fallback — "Asia/Dhaka" -> BD)
 *
 * Country names and flags come from the platform itself (Intl + Unicode
 * regional indicators), so there is no name table to maintain.
 */

/** Dial code -> ISO 3166-1 alpha-2. Longest prefix wins. */
const DIAL_CODES: Record<string, string> = {
  "1": "US",
  "7": "RU",
  "20": "EG",
  "27": "ZA",
  "30": "GR",
  "31": "NL",
  "32": "BE",
  "33": "FR",
  "34": "ES",
  "36": "HU",
  "39": "IT",
  "40": "RO",
  "41": "CH",
  "43": "AT",
  "44": "GB",
  "45": "DK",
  "46": "SE",
  "47": "NO",
  "48": "PL",
  "49": "DE",
  "51": "PE",
  "52": "MX",
  "53": "CU",
  "54": "AR",
  "55": "BR",
  "56": "CL",
  "57": "CO",
  "58": "VE",
  "60": "MY",
  "61": "AU",
  "62": "ID",
  "63": "PH",
  "64": "NZ",
  "65": "SG",
  "66": "TH",
  "81": "JP",
  "82": "KR",
  "84": "VN",
  "86": "CN",
  "90": "TR",
  "91": "IN",
  "92": "PK",
  "93": "AF",
  "94": "LK",
  "95": "MM",
  "98": "IR",
  "212": "MA",
  "213": "DZ",
  "216": "TN",
  "218": "LY",
  "220": "GM",
  "221": "SN",
  "233": "GH",
  "234": "NG",
  "237": "CM",
  "251": "ET",
  "254": "KE",
  "255": "TZ",
  "256": "UG",
  "260": "ZM",
  "263": "ZW",
  "291": "ER",
  "351": "PT",
  "352": "LU",
  "353": "IE",
  "354": "IS",
  "355": "AL",
  "356": "MT",
  "357": "CY",
  "358": "FI",
  "359": "BG",
  "370": "LT",
  "371": "LV",
  "372": "EE",
  "373": "MD",
  "374": "AM",
  "375": "BY",
  "376": "AD",
  "377": "MC",
  "380": "UA",
  "381": "RS",
  "382": "ME",
  "385": "HR",
  "386": "SI",
  "387": "BA",
  "389": "MK",
  "420": "CZ",
  "421": "SK",
  "423": "LI",
  "500": "FK",
  "501": "BZ",
  "502": "GT",
  "503": "SV",
  "504": "HN",
  "505": "NI",
  "506": "CR",
  "507": "PA",
  "509": "HT",
  "591": "BO",
  "593": "EC",
  "595": "PY",
  "598": "UY",
  "673": "BN",
  "674": "NR",
  "675": "PG",
  "676": "TO",
  "679": "FJ",
  "685": "WS",
  "852": "HK",
  "853": "MO",
  "855": "KH",
  "856": "LA",
  "880": "BD",
  "886": "TW",
  "960": "MV",
  "961": "LB",
  "962": "JO",
  "963": "SY",
  "964": "IQ",
  "965": "KW",
  "966": "SA",
  "967": "YE",
  "968": "OM",
  "970": "PS",
  "971": "AE",
  "972": "IL",
  "973": "BH",
  "974": "QA",
  "975": "BT",
  "976": "MN",
  "977": "NP",
  "992": "TJ",
  "993": "TM",
  "994": "AZ",
  "995": "GE",
  "996": "KG",
  "998": "UZ",
};

const DIAL_PREFIXES = Object.keys(DIAL_CODES).sort((a, b) => b.length - a.length);

/** Common IANA zones -> ISO 3166-1 alpha-2. */
const TIMEZONE_COUNTRIES: Record<string, string> = {
  "Asia/Dhaka": "BD",
  "Asia/Kolkata": "IN",
  "Asia/Calcutta": "IN",
  "Asia/Karachi": "PK",
  "Asia/Kathmandu": "NP",
  "Asia/Colombo": "LK",
  "Asia/Yangon": "MM",
  "Asia/Thimphu": "BT",
  "Asia/Kabul": "AF",
  "Asia/Tehran": "IR",
  "Asia/Baghdad": "IQ",
  "Asia/Riyadh": "SA",
  "Asia/Dubai": "AE",
  "Asia/Qatar": "QA",
  "Asia/Kuwait": "KW",
  "Asia/Bahrain": "BH",
  "Asia/Muscat": "OM",
  "Asia/Amman": "JO",
  "Asia/Beirut": "LB",
  "Asia/Jerusalem": "IL",
  "Asia/Damascus": "SY",
  "Asia/Baku": "AZ",
  "Asia/Tbilisi": "GE",
  "Asia/Yerevan": "AM",
  "Asia/Tashkent": "UZ",
  "Asia/Almaty": "KZ",
  "Asia/Bishkek": "KG",
  "Asia/Dushanbe": "TJ",
  "Asia/Ashgabat": "TM",
  "Asia/Ulaanbaatar": "MN",
  "Asia/Bangkok": "TH",
  "Asia/Ho_Chi_Minh": "VN",
  "Asia/Saigon": "VN",
  "Asia/Phnom_Penh": "KH",
  "Asia/Vientiane": "LA",
  "Asia/Jakarta": "ID",
  "Asia/Makassar": "ID",
  "Asia/Jayapura": "ID",
  "Asia/Kuala_Lumpur": "MY",
  "Asia/Singapore": "SG",
  "Asia/Manila": "PH",
  "Asia/Brunei": "BN",
  "Asia/Hong_Kong": "HK",
  "Asia/Macau": "MO",
  "Asia/Taipei": "TW",
  "Asia/Shanghai": "CN",
  "Asia/Urumqi": "CN",
  "Asia/Tokyo": "JP",
  "Asia/Seoul": "KR",
  "Asia/Pyongyang": "KP",
  "Europe/London": "GB",
  "Europe/Dublin": "IE",
  "Europe/Lisbon": "PT",
  "Europe/Madrid": "ES",
  "Europe/Paris": "FR",
  "Europe/Brussels": "BE",
  "Europe/Amsterdam": "NL",
  "Europe/Luxembourg": "LU",
  "Europe/Berlin": "DE",
  "Europe/Zurich": "CH",
  "Europe/Vienna": "AT",
  "Europe/Rome": "IT",
  "Europe/Malta": "MT",
  "Europe/Athens": "GR",
  "Europe/Copenhagen": "DK",
  "Europe/Oslo": "NO",
  "Europe/Stockholm": "SE",
  "Europe/Helsinki": "FI",
  "Europe/Tallinn": "EE",
  "Europe/Riga": "LV",
  "Europe/Vilnius": "LT",
  "Europe/Warsaw": "PL",
  "Europe/Prague": "CZ",
  "Europe/Bratislava": "SK",
  "Europe/Budapest": "HU",
  "Europe/Bucharest": "RO",
  "Europe/Sofia": "BG",
  "Europe/Belgrade": "RS",
  "Europe/Zagreb": "HR",
  "Europe/Ljubljana": "SI",
  "Europe/Sarajevo": "BA",
  "Europe/Skopje": "MK",
  "Europe/Podgorica": "ME",
  "Europe/Tirane": "AL",
  "Europe/Kyiv": "UA",
  "Europe/Kiev": "UA",
  "Europe/Minsk": "BY",
  "Europe/Chisinau": "MD",
  "Europe/Moscow": "RU",
  "Europe/Istanbul": "TR",
  "Europe/Nicosia": "CY",
  "Africa/Cairo": "EG",
  "Africa/Casablanca": "MA",
  "Africa/Algiers": "DZ",
  "Africa/Tunis": "TN",
  "Africa/Tripoli": "LY",
  "Africa/Lagos": "NG",
  "Africa/Accra": "GH",
  "Africa/Nairobi": "KE",
  "Africa/Dar_es_Salaam": "TZ",
  "Africa/Kampala": "UG",
  "Africa/Addis_Ababa": "ET",
  "Africa/Johannesburg": "ZA",
  "Africa/Harare": "ZW",
  "Africa/Lusaka": "ZM",
  "Africa/Dakar": "SN",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Phoenix": "US",
  "America/Los_Angeles": "US",
  "America/Anchorage": "US",
  "Pacific/Honolulu": "US",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "America/Edmonton": "CA",
  "America/Winnipeg": "CA",
  "America/Halifax": "CA",
  "America/Mexico_City": "MX",
  "America/Guatemala": "GT",
  "America/Panama": "PA",
  "America/Bogota": "CO",
  "America/Lima": "PE",
  "America/Caracas": "VE",
  "America/Santiago": "CL",
  "America/Sao_Paulo": "BR",
  "America/Manaus": "BR",
  "America/Argentina/Buenos_Aires": "AR",
  "America/Montevideo": "UY",
  "America/Asuncion": "PY",
  "America/La_Paz": "BO",
  "America/Havana": "CU",
  "Australia/Sydney": "AU",
  "Australia/Melbourne": "AU",
  "Australia/Brisbane": "AU",
  "Australia/Perth": "AU",
  "Australia/Adelaide": "AU",
  "Pacific/Auckland": "NZ",
  "Pacific/Fiji": "FJ",
  "Pacific/Port_Moresby": "PG",
};

const ISO2 = /^[A-Z]{2}$/;

/** "+8801712345678" -> "BD". Returns null when no dial code matches. */
export function countryFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, "").replace(/^0+/, "");
  // Guess only from something long enough to be a real international number;
  // otherwise a stray "12" would match +1 and fly a US flag.
  if (digits.length < 7) return null;
  for (const prefix of DIAL_PREFIXES) {
    if (digits.startsWith(prefix)) return DIAL_CODES[prefix];
  }
  return null;
}

/** "bn-BD" -> "BD". Uses the platform's own locale parser, so there is no table. */
export function countryFromLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  try {
    const region = new Intl.Locale(locale).region;
    return region && ISO2.test(region) ? region : null;
  } catch {
    return null;
  }
}

/** "Asia/Dhaka" -> "BD". */
export function countryFromTimezone(timezone: string | null | undefined): string | null {
  if (!timezone) return null;
  return TIMEZONE_COUNTRIES[timezone] ?? null;
}

/** "BD" -> "🇧🇩", built from Unicode regional indicators. */
export function flagEmoji(countryCode: string | null | undefined): string | null {
  const code = countryCode?.trim().toUpperCase();
  if (!code || !ISO2.test(code)) return null;
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** "BD" -> "Bangladesh", from the platform's own region names. */
export function countryName(countryCode: string | null | undefined, locale = "en"): string | null {
  const code = countryCode?.trim().toUpperCase();
  if (!code || !ISO2.test(code)) return null;
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? null;
  } catch {
    return code;
  }
}

export interface ResolvedCountry {
  code: string;
  name: string;
  flag: string;
  /** Which signal produced it, so the UI can say how confident it is. */
  source: "phone" | "locale" | "timezone";
}

/**
 * Best free guess from whatever signals a conversation has. Phone wins: a dial
 * code is a fact about the number, while a locale or timezone only describes
 * the device someone happens to be using.
 */
export function resolveCountry(signals: {
  phone?: string | null;
  locale?: string | null;
  timezone?: string | null;
}): ResolvedCountry | null {
  const candidates: Array<[string | null, ResolvedCountry["source"]]> = [
    [countryFromPhone(signals.phone), "phone"],
    [countryFromLocale(signals.locale), "locale"],
    [countryFromTimezone(signals.timezone), "timezone"],
  ];
  for (const [code, source] of candidates) {
    if (!code) continue;
    const name = countryName(code);
    const flag = flagEmoji(code);
    if (name && flag) return { code, name, flag, source };
  }
  return null;
}
