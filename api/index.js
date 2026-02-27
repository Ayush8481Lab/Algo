const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

// Custom Headers to prevent getting blocked
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

// Clean text for perfect matching
const clean = (s) => (s || "").toLowerCase().replace(/[^\w\s]|_/g, "").replace(/\s+/g, " ").trim();

// EXACT MATCHING LOGIC FROM YOUR yyyyyy.html
function performMatching(apiData, targetTrack, targetArtist, isJioSaavn = false) {
    if (!apiData || apiData.length === 0) return null;
    const tTitle = clean(targetTrack);
    const tArtist = clean(targetArtist);
    let bestMatch = null;
    let highestScore = 0;

    apiData.forEach(track => {
        if (!track) return;
        let rTitle = clean(isJioSaavn ? (track.name || track.title) : track.trackName);
        let rArtists =[];
        
        if (isJioSaavn) {
            if (track.artists && track.artists.primary) {
                rArtists = track.artists.primary.map(a => clean(a.name));
            } else if (track.primary_artists) {
                rArtists = track.primary_artists.split(',').map(clean);
            }
        } else {
            rArtists =[clean(track.artistName)];
        }

        let score = 0;
        let artistMatched = false;

        if (tArtist.length > 0) {
            for (let ra of rArtists) {
                if (ra === tArtist) { score += 100; artistMatched = true; break; }
                else if (ra.includes(tArtist) || tArtist.includes(ra)) { score += 80; artistMatched = true; break; }
            }
            if (!artistMatched) score = 0;
        } else {
            score += 50; // Boost if no artist provided
        }

        if (score > 0) {
            if (rTitle === tTitle) score += 100;
            else if (rTitle.startsWith(tTitle) || tTitle.startsWith(rTitle)) score += 80;
            else if (rTitle.includes(tTitle)) score += 50;
        }

        if (score > highestScore) {
            highestScore = score;
            bestMatch = track;
        }
    });
    return highestScore > 0 ? bestMatch : null;
}

// 1. GET SPOTIFY URL USING OFFICIAL FREE API (100% Reliable)
async function getSpotifyUrl(adamId) {
    if (!adamId) return null;
    try {
        const { data } = await axios.get(`https://api.song.link/v1-alpha.1/links?itunesId=${adamId}`, { headers });
        if (data && data.linksByPlatform && data.linksByPlatform.spotify) {
            return data.linksByPlatform.spotify.url;
        }
    } catch (e) {
        console.error("Song.link API Error:", e.message);
    }
    return null;
}

// 2. SCRAPE APPLE MUSIC HTML FOR RECOMMENDATIONS DEEPLY
async function getAppleMusicData(url) {
    try {
        const { data } = await axios.get(url, { headers });
        const $ = cheerio.load(data);
        const jsonText = $('#serialized-server-data').text() || $('#serialized-server-data').html();
        if (!jsonText) return { moreFromArtist: [], recommendations:[] };

        const jsonData = JSON.parse(jsonText);
        let moreFromArtist = [];
        let recommendations = [];
        let sections =[];

        // Deep search to find all sections
        function findSections(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj.sections)) sections = sections.concat(obj.sections);
            for (let key in obj) {
                if (typeof obj[key] === 'object') findSections(obj[key]);
            }
        }
        findSections(jsonData);

        sections.forEach(sec => {
            const headerTitle = sec.header?.item?.titleLink?.title || sec.header?.item?.title || "";
            
            if (headerTitle.includes("More by") || headerTitle.includes("Top Songs")) {
                sec.items?.forEach(item => {
                    let title = item.titleLinks?.[0]?.title || item.title || "";
                    let adamId = item.contentDescriptor?.identifiers?.storeAdamID || item.id;
                    if(title && adamId) moreFromArtist.push({ title, adamId });
                });
            } 
            else if (headerTitle.includes("You Might Also Like") || headerTitle.includes("Featured On") || headerTitle.includes("Similar")) {
                sec.items?.forEach(item => {
                    let title = item.titleLinks?.[0]?.title || item.accessibilityLabel || item.title || "";
                    let adamId = item.contentDescriptor?.identifiers?.storeAdamID || item.id;
                    if(title && adamId) recommendations.push({ title, adamId });
                });
            }
        });

        return { moreFromArtist, recommendations };
    } catch (e) {
        return { moreFromArtist: [], recommendations:[] };
    }
}

// 3. SEARCH JIOSAAVN
async function getJioSaavnData(title, artist) {
    try {
        // Clean title heavily so JioSaavn doesn't get confused
        const cleanQuery = title.replace(/\(From.*?\)/gi, '').replace(/\[From.*?\]/gi, '').replace(/\(Original.*?\)/gi, '').replace(/- Single/gi, '').replace(/- EP/gi, '').trim();
        const { data } = await axios.get(`https://ayushm-psi.vercel.app/api/search/songs?query=${encodeURIComponent(cleanQuery + " " + artist)}`, { headers });
        return performMatching(data?.data?.results ||[], cleanQuery, artist, true);
    } catch (e) { 
        return null; 
    }
}

// 4. MAIN API ENDPOINT
app.get('/api/search', async (req, res) => {
    const { song, artist } = req.query;
    if (!song || !artist) return res.status(400).json({ error: "Missing 'song' or 'artist' parameters" });

    try {
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(song + " " + artist)}&entity=song&limit=15`;
        const { data: itunesData } = await axios.get(itunesUrl, { headers });
        const matchedTrack = performMatching(itunesData.results, song, artist, false);
        
        if (!matchedTrack) return res.status(404).json({ error: "Song not found on iTunes" });

        const trackId = matchedTrack.trackId;
        const trackViewUrl = matchedTrack.trackViewUrl;

        // Fetch Current Song Data concurrently
        const[spotifyUrl, jiosaavnData, appleData] = await Promise.all([
            getSpotifyUrl(trackId),
            getJioSaavnData(song, artist),
            getAppleMusicData(trackViewUrl)
        ]);

        // Helper: Process recommendations and attach Spotify + JioSaavn data
        const processList = async (list) => {
            const processed =[];
            // Limit to 4 to prevent Vercel 10s Serverless Timeout
            for (let item of list.slice(0, 4)) { 
                const cleanTrackName = item.title.split(' - ')[0].replace(/\(From.*?\)/gi, '').trim();
                
                const[itemJioSaavn, itemSpotify] = await Promise.all([
                    getJioSaavnData(cleanTrackName, ""), // Empty artist forces title-only match
                    getSpotifyUrl(item.adamId)
                ]);

                // Only append if JioSaavn match is found
                if (itemJioSaavn) {
                    processed.push({ 
                        title: item.title, 
                        apple_id: item.adamId, 
                        spotify_url: itemSpotify, 
                        jiosaavn_data: itemJioSaavn 
                    });
                }
            }
            return processed;
        };

        const more_from_artist = await processList(appleData.moreFromArtist);
        const recommendations = await processList(appleData.recommendations);

        res.json({
            success: true,
            current_song: { 
                title: matchedTrack.trackName, 
                artist: matchedTrack.artistName, 
                apple_id: trackId, 
                spotify_url: spotifyUrl, 
                jiosaavn_data: jiosaavnData 
            },
            more_from_artist,
            recommendations
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

module.exports = app;
