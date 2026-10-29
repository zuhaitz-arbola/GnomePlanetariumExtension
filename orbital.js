/* SPDX-License-Identifier: GPL-3.0-or-later */

/**
 * Keplerian Orbital Mechanics Module for GNOME Shell 46
 * Calculates real-time heliocentric positions and astronomical events.
 */

const DEG = Math.PI / 180.0;
const RAD = 180.0 / Math.PI;

// J2000 epoch is 2000-01-01 12:00:00 UTC
const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);

// NASA/JPL Keplerian Elements (approximate for J2000 + secular rates)
// Data structure:
// a: semi-major axis (AU)
// e: eccentricity
// I: inclination (deg)
// L: mean longitude (deg)
// longPeri: longitude of perihelion (deg)
// longNode: longitude of ascending node (deg)
// Rates are per Julian century (36525 days)
const PLANET_DATA = {
    Mercury: {
        base: { a: 0.38709927, e: 0.20563593, I: 7.00497902, L: 252.25032350, longPeri: 77.45779628, longNode: 48.33076593 },
        rates: { a: 0.00000037, e: 0.00001906, I: -0.00594749, L: 149472.67411175, longPeri: 0.16047689, longNode: -0.12534081 },
        color: [0.70, 0.70, 0.75, 1.0]
    },
    Venus: {
        base: { a: 0.72333566, e: 0.00677672, I: 3.39467605, L: 181.97909950, longPeri: 131.60246718, longNode: 76.67984255 },
        rates: { a: 0.00000390, e: -0.00004107, I: -0.00078890, L: 58517.81538605, longPeri: 0.00268329, longNode: -0.27769418 },
        color: [0.95, 0.85, 0.55, 1.0]
    },
    Earth: { // Earth/Moon barycenter
        base: { a: 1.00000261, e: 0.01671123, I: -0.00001531, L: 100.46457166, longPeri: 102.93768193, longNode: 0.0 },
        rates: { a: 0.00000562, e: -0.00004392, I: -0.01294668, L: 35999.37244981, longPeri: 0.32327364, longNode: 0.0 },
        color: [0.30, 0.65, 0.95, 1.0]
    },
    Mars: {
        base: { a: 1.52371034, e: 0.09339410, I: 1.84969142, L: -4.55343205, longPeri: -23.94362959, longNode: 49.55953891 },
        rates: { a: 0.00001847, e: 0.00007882, I: -0.00813131, L: 19140.30268499, longPeri: 0.44441088, longNode: -0.29257343 },
        color: [0.90, 0.45, 0.30, 1.0]
    },
    Jupiter: {
        base: { a: 5.20288700, e: 0.04838624, I: 1.30439695, L: 34.39644051, longPeri: 14.72847983, longNode: 100.47390909 },
        rates: { a: -0.00011607, e: -0.00013253, I: -0.00183714, L: 3034.74612775, longPeri: 0.21252668, longNode: 0.20469106 },
        color: [0.85, 0.75, 0.55, 1.0]
    },
    Saturn: {
        base: { a: 9.53667594, e: 0.05386179, I: 2.48599187, L: 49.95424423, longPeri: 92.59887831, longNode: 113.66242448 },
        rates: { a: -0.00125060, e: -0.00050991, I: 0.00193609, L: 1222.49362201, longPeri: -0.41897216, longNode: -0.28867794 },
        color: [0.80, 0.72, 0.50, 1.0]
    },
    Uranus: {
        base: { a: 19.18916464, e: 0.04725744, I: 0.77263783, L: 313.23218553, longPeri: 170.95427630, longNode: 74.01692503 },
        rates: { a: -0.00196176, e: -0.00004397, I: -0.00242939, L: 428.48202785, longPeri: 0.40805281, longNode: 0.04240589 },
        color: [0.55, 0.80, 0.85, 1.0]
    },
    Neptune: {
        base: { a: 30.06992276, e: 0.00859048, I: 1.77004347, L: -55.12002969, longPeri: 44.96476227, longNode: 131.78422574 },
        rates: { a: 0.00026291, e: 0.00005105, I: 0.00035372, L: 218.45945325, longPeri: -0.32241464, longNode: -0.00508664 },
        color: [0.35, 0.50, 0.85, 1.0]
    }
};

/**
 * Normalizes an angle to 0-360 degrees.
 * @param {number} angle 
 * @returns {number} Normalized angle
 */
function normalizeAngle(angle) {
    let a = angle % 360.0;
    if (a < 0) a += 360.0;
    return a;
}

/**
 * Solves Kepler's equation for Eccentric Anomaly using Newton-Raphson.
 * @param {number} M - Mean anomaly (radians)
 * @param {number} e - Eccentricity
 * @returns {number} Eccentric anomaly E (radians)
 */
function solveKepler(M, e) {
    let E = M + e * Math.sin(M);
    for (let i = 0; i < 6; i++) {
        let deltaE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        E -= deltaE;
    }
    return E;
}

/**
 * Calculates planetary positions.
 * @param {Date} date
 * @returns {Array<Object>}
 */
export function getPlanetPositions(date) {
    // Centuries since J2000
    const T = (date.getTime() - J2000) / (1000 * 60 * 60 * 24 * 36525);
    
    let result = [];
    let earthPos = null;

    for (const [name, data] of Object.entries(PLANET_DATA)) {
        const a = data.base.a + data.rates.a * T;
        const e = data.base.e + data.rates.e * T;
        const I = (data.base.I + data.rates.I * T) * DEG;
        const L = normalizeAngle(data.base.L + data.rates.L * T) * DEG;
        const longPeri = normalizeAngle(data.base.longPeri + data.rates.longPeri * T) * DEG;
        const longNode = normalizeAngle(data.base.longNode + data.rates.longNode * T) * DEG;

        const argPeri = longPeri - longNode;
        const M = L - longPeri;
        const E = solveKepler(M, e);

        // Orbital plane coordinates
        const xPrime = a * (Math.cos(E) - e);
        const yPrime = a * Math.sqrt(1 - e * e) * Math.sin(E);

        // Ecliptic plane coordinates
        const x = (Math.cos(longNode) * Math.cos(argPeri) - Math.sin(longNode) * Math.sin(argPeri) * Math.cos(I)) * xPrime +
                  (-Math.cos(longNode) * Math.sin(argPeri) - Math.sin(longNode) * Math.cos(argPeri) * Math.cos(I)) * yPrime;
        
        const y = (Math.sin(longNode) * Math.cos(argPeri) + Math.cos(longNode) * Math.sin(argPeri) * Math.cos(I)) * xPrime +
                  (-Math.sin(longNode) * Math.sin(argPeri) + Math.cos(longNode) * Math.cos(argPeri) * Math.cos(I)) * yPrime;
        
        const z = (Math.sin(argPeri) * Math.sin(I)) * xPrime + 
                  (Math.cos(argPeri) * Math.sin(I)) * yPrime;

        const distanceFromSun = Math.sqrt(x*x + y*y + z*z);

        const pos = { name, x, y, distanceFromSun, color: data.color, _z: z };
        result.push(pos);
        if (name === 'Earth') {
            earthPos = pos;
        }
    }

    // Calculate distance from Earth
    for (let p of result) {
        if (p.name === 'Earth') {
            p.distanceFromEarth = 0;
        } else {
            const dx = p.x - earthPos.x;
            const dy = p.y - earthPos.y;
            const dz = p._z - earthPos._z;
            p.distanceFromEarth = Math.sqrt(dx*dx + dy*dy + dz*dz);
        }
        delete p._z;
    }

    return result;
}

/**
 * Returns the closest planet to Earth.
 * @param {Array<Object>} positions
 * @returns {Object} {name, distance}
 */
export function getClosestPlanet(positions) {
    let closest = null;
    let minDist = Infinity;
    for (const p of positions) {
        if (p.name !== 'Earth' && p.distanceFromEarth < minDist) {
            minDist = p.distanceFromEarth;
            closest = { name: p.name, distance: minDist };
        }
    }
    return closest;
}

/**
 * Returns Earth-Sun distance in AU.
 * @param {Array<Object>} positions
 * @returns {number} Distance in AU
 */
export function getEarthSunDistance(positions) {
    const earth = positions.find(p => p.name === 'Earth');
    return earth ? earth.distanceFromSun : 1.0;
}

/**
 * Approximates Earth's orbital velocity in km/s.
 * @param {Date} date
 * @returns {number} Velocity in km/s
 */
export function getEarthOrbitalVelocity(date) {
    // using vis-viva equation v^2 = GM (2/r - 1/a)
    const pos = getPlanetPositions(date);
    const r = getEarthSunDistance(pos);
    const a = 1.00000011; // AU approx semi major
    // 29.78 km/s is mean orbital velocity
    return 29.78 * Math.sqrt((2 / r) - (1 / a));
}

/**
 * Returns day of year (1-366)
 * @param {Date} date
 * @returns {number}
 */
export function getDayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = (date.getTime() - start.getTime()) + (start.getTimezoneOffset() - date.getTimezoneOffset()) * 60000;
    const oneDay = 1000 * 60 * 60 * 24;
    return Math.floor(diff / oneDay);
}

/**
 * Approximates Earth's ecliptic longitude from positions.
 */
function getEarthEclipticLongitude(date) {
    const T = (date.getTime() - J2000) / (1000 * 60 * 60 * 24 * 36525);
    const L = normalizeAngle(PLANET_DATA.Earth.base.L + PLANET_DATA.Earth.rates.L * T);
    return L;
}

/**
 * Returns astronomical season based on date.
 * @param {Date} date
 * @param {boolean} latitudeIsNorth
 * @returns {string}
 */
export function getAstronomicalSeason(date, latitudeIsNorth) {
    const L = getEarthEclipticLongitude(date);
    
    let season = '';
    if (L >= 0 && L < 90) season = 'Autumn';
    else if (L >= 90 && L < 180) season = 'Winter';
    else if (L >= 180 && L < 270) season = 'Spring';
    else season = 'Summer';
    
    if (!latitudeIsNorth) {
        if (season === 'Spring') season = 'Autumn';
        else if (season === 'Summer') season = 'Winter';
        else if (season === 'Autumn') season = 'Spring';
        else if (season === 'Winter') season = 'Summer';
    }
    return season;
}

/**
 * Returns next equinox or solstice.
 * @param {Date} date
 * @param {boolean} latitudeIsNorth
 * @returns {Object} {name, date}
 */
export function getNextEquinoxSolstice(date, latitudeIsNorth) {
    let targetL = 0;
    const currentL = getEarthEclipticLongitude(date);
    
    if (currentL < 90) targetL = 90;
    else if (currentL < 180) targetL = 180;
    else if (currentL < 270) targetL = 270;
    else targetL = 360;

    // Binary search for exact time
    let low = date.getTime();
    let high = low + 100 * 24 * 60 * 60 * 1000; // max 100 days
    
    for (let i = 0; i < 20; i++) {
        let mid = (low + high) / 2;
        let lMid = getEarthEclipticLongitude(new Date(mid));
        if (targetL === 360 && lMid < 90) { // wrap around
            high = mid;
        } else if (lMid < targetL) {
            low = mid;
        } else {
            high = mid;
        }
    }
    
    const eventDate = new Date(low);
    targetL = targetL % 360;
    
    let name = '';
    if (targetL === 0) name = latitudeIsNorth ? 'Autumn Equinox' : 'Spring Equinox';
    else if (targetL === 90) name = latitudeIsNorth ? 'Winter Solstice' : 'Summer Solstice';
    else if (targetL === 180) name = latitudeIsNorth ? 'Spring Equinox' : 'Autumn Equinox';
    else if (targetL === 270) name = latitudeIsNorth ? 'Summer Solstice' : 'Winter Solstice';
    
    return { name, date: eventDate };
}

/**
 * Roughly estimates visible planets after sunset.
 * @param {Array<Object>} positions
 * @param {Date} date
 * @param {number} lat
 * @param {number} lon
 * @returns {Array<string>}
 */
export function getVisiblePlanets(positions, date, lat, lon) {
    const earth = positions.find(p => p.name === 'Earth');
    if (!earth) return [];

    let visible = [];
    for (const p of positions) {
        if (p.name === 'Earth') continue;
        
        const esX = -earth.x;
        const esY = -earth.y;

        const epX = p.x - earth.x;
        const epY = p.y - earth.y;
        
        const distEP = Math.sqrt(epX*epX + epY*epY);
        const distES = Math.sqrt(esX*esX + esY*esY);
        
        const dot = esX*epX + esY*epY;
        const cosElongation = dot / (distEP * distES);
        const elongation = Math.acos(cosElongation) * RAD;
        
        if (elongation > 15) {
            visible.push(p.name);
        }
    }
    
    return visible;
}
