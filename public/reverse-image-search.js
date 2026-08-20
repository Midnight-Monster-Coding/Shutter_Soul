// reverse-image-search.js — Shutter Soul Online Image Detector
// ═══════════════════════════════════════════════════════════════
//
// TWO INDEPENDENT DETECTION LAYERS:
//
//  LAYER 1 — EXIF Metadata Analysis  (100% FREE, runs locally, no API needed)
//    Real camera photos contain embedded metadata: camera make/model,
//    date taken, focal length, sometimes GPS. Downloaded stock photos,
//    screenshots, and wallpapers almost always have this data stripped.
//    This runs on the LOCAL FILE before anything is uploaded.
//
//  LAYER 2 — Google Cloud Vision Web Detection  (FREE: 1,000/month)
//    The REAL reverse image search API. Sends the uploaded image to
//    Google Vision which checks billions of indexed web pages for
//    matching or similar images. Replaces the broken Custom Search
//    approach which was never doing reverse search at all.
//
// ═══════════════════════════════════════════════════════════════
// HOW TO CALL FROM index.html:
//
//  const checker = new MultiLayerImageChecker(GOOGLE_VISION_API_KEY);
//
//  // Step 2 (before ImgBB — local file check):
//  const exifResult = await checker.checkFileLocally(selectedFile);
//  if (exifResult.isFoundOnline) { ... block ... }
//
//  // Step 5 (after ImgBB — online check):
//  const webResult  = await checker.checkImageOnline(photoURL);
//  if (webResult.isFoundOnline)  { ... block ... }
//
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// SECTION 1 — EXIF METADATA ANALYSIS  (Layer 1, always free)
// ─────────────────────────────────────────────────────────────

class EXIFAnalyzer {

    /**
     * Parse raw EXIF bytes from a JPEG file manually.
     * No external library needed — reads the APP1/EXIF segment directly.
     */
    async _readExifFromFile(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const buffer = e.target.result;
                    const view   = new DataView(buffer);
                    const tags   = {};

                    // JPEG starts with 0xFFD8
                    if (view.getUint16(0) !== 0xFFD8) { resolve(null); return; }

                    let offset = 2;
                    while (offset < view.byteLength - 2) {
                        const marker = view.getUint16(offset);
                        offset += 2;

                        // APP1 marker (0xFFE1) contains EXIF
                        if (marker === 0xFFE1) {
                            const segLen = view.getUint16(offset);
                            // Check for "Exif" header
                            const exifHeader = String.fromCharCode(
                                view.getUint8(offset + 2),
                                view.getUint8(offset + 3),
                                view.getUint8(offset + 4),
                                view.getUint8(offset + 5)
                            );
                            if (exifHeader === 'Exif') {
                                const tiffStart = offset + 8;
                                const littleEndian = view.getUint16(tiffStart) === 0x4949;
                                const ifdOffset    = tiffStart + view.getUint32(tiffStart + 4, littleEndian);

                                tags._raw         = true;
                                tags._littleEndian = littleEndian;
                                tags._tiffStart    = tiffStart;

                                // Read IFD entries
                                const entryCount = view.getUint16(ifdOffset, littleEndian);
                                for (let i = 0; i < entryCount; i++) {
                                    const entryOffset = ifdOffset + 2 + (i * 12);
                                    const tag  = view.getUint16(entryOffset, littleEndian);
                                    const type = view.getUint16(entryOffset + 2, littleEndian);
                                    const val  = view.getUint32(entryOffset + 8, littleEndian);

                                    // Tag 0x010F = Make, 0x0110 = Model, 0x0132 = DateTime
                                    // 0x9003 = DateTimeOriginal, 0x8827 = ISO, 0x920A = FocalLength
                                    if ([0x010F, 0x0110, 0x0132, 0x9003, 0x8827, 0x920A,
                                         0x8822, 0x9202, 0x9203, 0x8825].includes(tag)) {
                                        if (type === 2) { // ASCII string
                                            const count = view.getUint32(entryOffset + 4, littleEndian);
                                            const strOffset = count > 4
                                                ? tiffStart + val
                                                : entryOffset + 8;
                                            let str = '';
                                            for (let c = 0; c < count - 1; c++) {
                                                const ch = view.getUint8(strOffset + c);
                                                if (ch === 0) break;
                                                str += String.fromCharCode(ch);
                                            }
                                            tags[tag] = str.trim();
                                        } else {
                                            tags[tag] = val;
                                        }
                                    }
                                }
                            }
                            offset += segLen;
                        } else if ((marker & 0xFF00) === 0xFF00) {
                            offset += view.getUint16(offset);
                        } else {
                            break;
                        }
                    }

                    resolve(Object.keys(tags).length > 1 ? tags : null);
                } catch (_) {
                    resolve(null);
                }
            };
            reader.onerror = () => resolve(null);
            reader.readAsArrayBuffer(file.slice(0, 256 * 1024)); // Read first 256KB only
        });
    }

    /**
     * Analyse the file's EXIF metadata and return a trust signal.
     *
     * @param {File} file
     * @returns {Promise<{
     *   hasCameraMetadata: boolean,
     *   hasDateTaken:      boolean,
     *   hasFocalLength:    boolean,
     *   cameraMake:        string|null,
     *   cameraModel:       string|null,
     *   dateTaken:         string|null,
     *   suspicionScore:    number,   // 0 = clean, higher = more suspicious
     *   verdict:           'original'|'suspicious'|'likely_downloaded'
     * }>}
     */
    async analyze(file) {
        const result = {
            hasCameraMetadata: false,
            hasDateTaken:      false,
            hasFocalLength:    false,
            cameraMake:        null,
            cameraModel:       null,
            dateTaken:         null,
            suspicionScore:    0,
            verdict:           'suspicious'
        };

        // Only JPEG/JPG carry EXIF reliably; PNG/WebP get a neutral pass
        if (!file.type.includes('jpeg') && !file.type.includes('jpg')) {
            result.verdict = 'suspicious'; // PNG/WebP - no EXIF standard, can't judge
            result.suspicionScore = 20;    // Small penalty but not blocking
            return result;
        }

        const tags = await this._readExifFromFile(file);

        if (!tags || !tags._raw) {
            // JPEG with NO EXIF at all — strong signal of a downloaded/processed image
            result.suspicionScore = 70;
            result.verdict = 'likely_downloaded';
            return result;
        }

        // 0x010F = Make, 0x0110 = Model
        if (tags[0x010F]) {
            result.hasCameraMetadata = true;
            result.cameraMake = tags[0x010F];
        }
        if (tags[0x0110]) {
            result.hasCameraMetadata = true;
            result.cameraModel = tags[0x0110];
        }
        // 0x9003 = DateTimeOriginal, 0x0132 = DateTime
        if (tags[0x9003] || tags[0x0132]) {
            result.hasDateTaken = true;
            result.dateTaken = tags[0x9003] || tags[0x0132];
        }
        // 0x920A = FocalLength
        if (tags[0x920A]) {
            result.hasFocalLength = true;
        }

        // Score: the more camera signals present, the more trustworthy
        if (!result.hasCameraMetadata) result.suspicionScore += 40;
        if (!result.hasDateTaken)      result.suspicionScore += 20;
        if (!result.hasFocalLength)    result.suspicionScore += 10;

        // Known stock photo / social media watermark strings in Make/Model
        const suspicious = ['adobe', 'photoshop', 'canva', 'snapseed', 'vsco',
                             'lightroom', 'meitu', 'beautycam', 'picsart'];
        const makeModel = `${result.cameraMake || ''} ${result.cameraModel || ''}`.toLowerCase();
        if (suspicious.some(s => makeModel.includes(s))) {
            result.suspicionScore += 30;
        }

        if (result.suspicionScore >= 60)      result.verdict = 'likely_downloaded';
        else if (result.suspicionScore >= 30) result.verdict = 'suspicious';
        else                                  result.verdict = 'original';

        return result;
    }
}

// ─────────────────────────────────────────────────────────────
// SECTION 2 — GOOGLE VISION WEB DETECTION  (Layer 2)
// Free tier: 1,000 requests/month. Real reverse image search.
// ─────────────────────────────────────────────────────────────

class VisionWebDetector {
    constructor(apiKey) {
        this.apiKey  = apiKey;
        this.baseUrl = 'https://vision.googleapis.com/v1/images:annotate';
    }

    _isConfigured() {
        return this.apiKey &&
               this.apiKey !== 'PASTE_YOUR_VISION_API_KEY_HERE' &&
               this.apiKey.startsWith('AIza');
    }

    /**
     * Convert an image URL to base64 via fetch (works for ImgBB URLs).
     */
    async _urlToBase64(imageUrl) {
        const response = await fetch(imageUrl);
        const blob     = await response.blob();
        return new Promise((resolve, reject) => {
            const reader   = new FileReader();
            reader.onload  = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Run Google Vision Web Detection on a public image URL.
     *
     * @param {string} imageUrl - Public URL (from ImgBB)
     * @returns {Promise<Object>} - Detection result
     */
    async detect(imageUrl) {
        if (!this._isConfigured()) {
            console.warn('⚠️ Google Vision API key not configured. Web detection skipped.');
            return { checked: false, reason: 'API key not configured' };
        }

        // Try URI-based detection first (fastest, no download needed)
        const requestBody = {
            requests: [{
                image:    { source: { imageUri: imageUrl } },
                features: [{ type: 'WEB_DETECTION', maxResults: 10 }]
            }]
        };

        const response = await fetch(`${this.baseUrl}?key=${this.apiKey}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            const msg = err?.error?.message || `HTTP ${response.status}`;
            console.warn(`⚠️ Vision API error: ${msg}`);
            return { checked: false, reason: msg };
        }

        const data         = await response.json();
        const webDetection = data?.responses?.[0]?.webDetection;

        if (!webDetection) {
            return { checked: true, isFoundOnline: false, source: 'Vision: no web data' };
        }

        // Full matches = identical image found online (strongest signal)
        const fullMatches   = webDetection.fullMatchingImages    || [];
        // Partial matches = visually similar (slightly weaker signal)
        const partialMatches = webDetection.partialMatchingImages || [];
        // Pages with matching images
        const pages         = webDetection.pagesWithMatchingImages || [];
        // Web entities (famous things this image depicts)
        const entities      = webDetection.webEntities           || [];

        console.log(`🔍 Vision Web Detection: ${fullMatches.length} full, ${partialMatches.length} partial, ${pages.length} pages`);

        if (fullMatches.length > 0) {
            return {
                checked:      true,
                isFoundOnline: true,
                confidence:   'high',
                source:       'Google Vision (exact match)',
                results:      fullMatches.slice(0, 3).map(m => ({
                    url:    m.url,
                    source: this._extractDomain(m.url)
                })),
                details: `Exact copy found on ${fullMatches.length} website(s)`
            };
        }

        if (partialMatches.length >= 3) {
            // 3+ partial matches = very likely a well-known/stock image
            return {
                checked:      true,
                isFoundOnline: true,
                confidence:   'medium',
                source:       'Google Vision (widely found online)',
                results:      partialMatches.slice(0, 3).map(m => ({
                    url:    m.url,
                    source: this._extractDomain(m.url)
                })),
                details: `Image found on multiple websites (${partialMatches.length} matches)`
            };
        }

        // Check if it matches a famous/stock entity with high confidence
        const highConfidenceEntity = entities.find(e => (e.score || 0) > 0.85 && e.description);
        if (highConfidenceEntity && pages.length > 0) {
            return {
                checked:      true,
                isFoundOnline: true,
                confidence:   'medium',
                source:       'Google Vision (known public image)',
                results:      [{ url: '', source: `Matches: "${highConfidenceEntity.description}"` }],
                details:      `Identified as a known public image`
            };
        }

        return {
            checked:      true,
            isFoundOnline: false,
            source:       'Google Vision',
            details:      'No significant online matches found'
        };
    }

    _extractDomain(url) {
        try   { return new URL(url).hostname.replace('www.', ''); }
        catch { return url.slice(0, 50); }
    }
}

// ─────────────────────────────────────────────────────────────
// SECTION 3 — MULTI-LAYER CHECKER (Public class used by index.html)
// ─────────────────────────────────────────────────────────────

class MultiLayerImageChecker {
    constructor(visionApiKey) {
        this.exif   = new EXIFAnalyzer();
        this.vision = new VisionWebDetector(visionApiKey);
    }

    /**
     * LAYER 1: Check the LOCAL FILE using EXIF analysis.
     * Call this BEFORE uploading to ImgBB.
     *
     * @param {File} file
     * @returns {Promise<{ isFoundOnline: boolean, source: string, results: [] }>}
     */
    async checkFileLocally(file) {
        try {
            console.log('🔍 EXIF metadata analysis...');
            const exif = await this.exif.analyze(file);
            console.log('📷 EXIF result:', exif);

            if (exif.verdict === 'likely_downloaded') {
                // Only block if it's a JPEG with NO camera metadata at all
                // (PNG/WebP get a pass since they don't carry EXIF)
                if (file.type.includes('jpeg') || file.type.includes('jpg')) {
                    const cameraInfo = exif.cameraMake
                        ? `Camera: ${exif.cameraMake} ${exif.cameraModel || ''}`.trim()
                        : 'No camera information found';

                    return {
                        isFoundOnline: true,
                        source:        'EXIF Analysis',
                        results:       [{ source: cameraInfo }],
                        details:       'This JPEG has no camera metadata, which is typical of downloaded or screenshot images.'
                    };
                }
            }

            return { isFoundOnline: false, source: 'EXIF Analysis', results: [] };

        } catch (err) {
            console.warn('⚠️ EXIF analysis failed (upload will proceed):', err.message);
            return { isFoundOnline: false, source: 'EXIF skipped', results: [] };
        }
    }

    /**
     * LAYER 2: Check the PUBLIC URL using Google Vision Web Detection.
     * Call this AFTER uploading to ImgBB.
     * This is what the old reverse-image-search.js tried and failed to do.
     *
     * @param {string} imageUrl - Public ImgBB URL
     * @returns {Promise<{ isFoundOnline: boolean, source: string, results: [] }>}
     */
    async checkImageOnline(imageUrl) {
        try {
            console.log('🔍 Google Vision Web Detection...');
            const result = await Promise.race([
                this.vision.detect(imageUrl),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Vision API timed out')), 10000)
                )
            ]);

            if (!result.checked) {
                // API not configured or failed — non-blocking
                return { isFoundOnline: false, source: result.reason || 'Skipped', results: [] };
            }

            return result;

        } catch (err) {
            console.warn('⚠️ Vision Web Detection failed (upload will proceed):', err.message);
            return { isFoundOnline: false, source: 'Web check unavailable', results: [] };
        }
    }
}

// ─────────────────────────────────────────────────────────────
// SECTION 4 — RATE LIMITER (unchanged — tracks daily API usage)
// ─────────────────────────────────────────────────────────────

class APIRateLimiter {
    constructor(maxCallsPerDay = 30) { // Vision API free tier: 1000/month ≈ 33/day
        this.maxCalls   = maxCallsPerDay;
        this.storageKey = 'visionAPI_calls';
    }

    canMakeCall() {
        try {
            const data  = this._getData();
            const today = new Date().toDateString();
            if (data.date !== today) { this.reset(); return true; }
            return data.count < this.maxCalls;
        } catch { return true; }
    }

    recordCall() {
        try {
            const data  = this._getData();
            const today = new Date().toDateString();
            localStorage.setItem(this.storageKey, JSON.stringify({
                date:  today,
                count: data.date === today ? data.count + 1 : 1
            }));
        } catch { /* ignore */ }
    }

    _getData() {
        try {
            const s = localStorage.getItem(this.storageKey);
            return s ? JSON.parse(s) : { date: '', count: 0 };
        } catch { return { date: '', count: 0 }; }
    }

    getRemainingCalls() {
        try {
            const data  = this._getData();
            const today = new Date().toDateString();
            if (data.date !== today) return this.maxCalls;
            return Math.max(0, this.maxCalls - data.count);
        } catch { return this.maxCalls; }
    }

    reset() {
        try { localStorage.removeItem(this.storageKey); } catch { /* ignore */ }
    }
}

// ─────────────────────────────────────────────────────────────
// Keep ReverseImageSearch as a named alias so nothing else breaks
// ─────────────────────────────────────────────────────────────
const ReverseImageSearch = MultiLayerImageChecker;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MultiLayerImageChecker, ReverseImageSearch, APIRateLimiter };
}