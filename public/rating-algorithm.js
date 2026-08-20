// rating-algorithm.js
// Google Gemini AI-Powered Photo Rating System
// Uses Gemini 2.5 Flash for fast, accurate photo analysis

/**
 * ⚠️ IMPORTANT: API KEY SETUP
 * * The Gemini API key MUST come from Google AI Studio:
 * → https://aistudio.google.com/app/apikey
 * * It will start with "AIza..." (e.g. AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXX)
 * * Do NOT use keys from Google Cloud Console > Credentials > Service Accounts.
 * Those are OAuth2 credentials and will give the error:
 * "API keys are not supported by this API. Expected OAuth2 access token..."
 *
 * Also: In Google Cloud Console, if you add HTTP referrer restrictions to the key,
 * make sure to add your exact domain (e.g. yoursite.com/*) or remove restrictions
 * for local testing.
 */

class PhotoRatingSystem {
    constructor() {
        // ✅ REPLACE THIS with your key from https://aistudio.google.com/app/apikey
        // Must start with "AIza..." — NOT a service account key
        this.apiKey = 'AIzaSyDUEnLAv7D8M7SX5rf3viOevNsUTs_dF7s'; // e.g. AIzaSyBAqI0vsqvh...
        
        // Updated to gemini-2.5-flash for high-volume free tier access
        this.apiEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
        
        this.criteria = {
            composition: 25,
            technical:   20,
            lighting:    17,
            creativity:  15
        };
        
        this.maxScore = 77;
    }

    /**
     * Validate the API key format before making calls
     */
    _validateKey() {
        if (!this.apiKey || this.apiKey === 'PASTE_YOUR_AISTUDIO_KEY_HERE') {
            throw new Error(
                'Gemini API key not configured. ' +
                'Get your key from https://aistudio.google.com/app/apikey and paste it into rating-algorithm.js'
            );
        }
        if (!this.apiKey.startsWith('AIza')) {
            throw new Error(
                'Invalid Gemini API key format. ' +
                'The key must start with "AIza". ' +
                'Get a valid key from https://aistudio.google.com/app/apikey — ' +
                'do NOT use service account keys or OAuth credentials from Google Cloud Console.'
            );
        }
    }

    /**
     * Main function to analyze and rate a photo using Gemini AI
     * @param {string} imageDataUrl - Base64 data URL of the image (e.g. "data:image/jpeg;base64,...")
     * @returns {Promise<Object>} - Rating result with score and breakdown
     */
    async analyzePhoto(imageDataUrl) {
        try {
            console.log('🔍 Starting Gemini AI photo analysis...');

            // Validate key before any network call
            this._validateKey();

            if (!imageDataUrl || typeof imageDataUrl !== 'string') {
                throw new Error('Invalid image data provided to analyzePhoto()');
            }

            // Extract raw base64 from data URL
            const base64Image = imageDataUrl.includes('base64,')
                ? imageDataUrl.split('base64,')[1]
                : imageDataUrl;

            if (!base64Image || base64Image.length < 100) {
                throw new Error('Image data is too small or empty');
            }

            const mimeType = this.detectMimeType(imageDataUrl);
            const prompt   = this.createAnalysisPrompt();

            const requestBody = {
                contents: [{
                    parts: [
                        { text: prompt },
                        {
                            inline_data: {
                                mime_type: mimeType,
                                data:      base64Image
                            }
                        }
                    ]
                }],
                generationConfig: {
                    temperature:     0.1,
                    maxOutputTokens: 800,
                    topP:            0.8,
                    topK:            10
                },
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_NONE' }
                ]
            };

            const response = await fetch(`${this.apiEndpoint}?key=${this.apiKey}`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(requestBody)
            });

            if (!response.ok) {
                let errorData = {};
                try { errorData = await response.json(); } catch (_) {}

                const msg = errorData?.error?.message || `HTTP ${response.status}`;

                // Provide a helpful message for the most common mistake
                if (msg.includes('OAuth2') || msg.includes('API keys are not supported')) {
                    throw new Error(
                        'Wrong API key type. Your key must come from Google AI Studio ' +
                        '(https://aistudio.google.com/app/apikey) and start with "AIza". ' +
                        'Service account / OAuth credentials do NOT work here.'
                    );
                }
                if (response.status === 403 || msg.toLowerCase().includes('api key not valid')) {
                    throw new Error(
                        'API key is invalid or has HTTP referrer restrictions. ' +
                        'Check your key in Google AI Studio and ensure referrer restrictions ' +
                        'allow your domain (or remove restrictions for testing).'
                    );
                }

                throw new Error(`Gemini API error: ${msg}`);
            }

            const data   = await response.json();
            const result = this.parseGeminiResponse(data);

            console.log('✅ Gemini analysis complete. Score:', result.total);
            return result;

        } catch (error) {
            console.error('❌ Photo analysis error:', error.message);
            throw new Error(`Photo analysis failed: ${error.message}`);
        }
    }

    createAnalysisPrompt() {
        return `You are a professional photography critic. Analyze this photo and rate it.

CRITICAL RULES:
1. If NOT a real photograph (document, screenshot, meme, diagram, text, chart), respond: "REJECT: Not a photograph"
2. If extremely blurred or unusable, respond: "REJECT: Poor technical quality"
3. If blank, corrupted, or no clear subject, respond: "REJECT: Invalid image"
4. Only rate actual photographs

RATING CRITERIA (Total: 77 points):
1. COMPOSITION (0-25): Rule of thirds, balance, framing, subject placement
2. TECHNICAL (0-20): Focus, sharpness, exposure, noise, clarity
3. LIGHTING (0-17): Light quality, shadows, contrast, color temperature
4. CREATIVITY (0-15): Unique perspective, artistic value, emotional impact

RESPONSE FORMAT (EXACT):

If rejecting:
REJECT: [reason]

If rating:
COMPOSITION: [score]/25
TECHNICAL: [score]/20
LIGHTING: [score]/17
CREATIVITY: [score]/15
TOTAL: [sum]/77
FEEDBACK: [One clear sentence]

EXAMPLES:

Good landscape:
COMPOSITION: 21/25
TECHNICAL: 17/20
LIGHTING: 14/17
CREATIVITY: 11/15
TOTAL: 63/77
FEEDBACK: Well-composed with good lighting and clear focus.

Document:
REJECT: Not a photograph

Blurred:
REJECT: Poor technical quality

Analyze now:`;
    }

    parseGeminiResponse(geminiData) {
        try {
            const candidate = geminiData.candidates?.[0];
            if (!candidate) {
                throw new Error('No candidates in Gemini response — the request may have been blocked');
            }

            const text = candidate.content?.parts?.[0]?.text || '';
            console.log('📝 Gemini raw response:', text);

            if (!text.trim()) {
                throw new Error('Gemini returned an empty response');
            }

            // Check for rejection
            if (text.includes('REJECT:')) {
                const reason = text.split('REJECT:')[1]?.split('\n')[0]?.trim()
                    || 'Image does not meet quality standards';
                return {
                    rejected:  true,
                    reason,
                    total:     0,
                    breakdown: { composition: 0, technical: 0, lighting: 0, creativity: 0 },
                    feedback:  reason
                };
            }

            const composition = this.extractScore(text, 'COMPOSITION:', 25);
            const technical   = this.extractScore(text, 'TECHNICAL:',   20);
            const lighting    = this.extractScore(text, 'LIGHTING:',    17);
            const creativity  = this.extractScore(text, 'CREATIVITY:',  15);

            const total = composition + technical + lighting + creativity;

            const feedbackMatch = text.match(/FEEDBACK:\s*(.+)/i);
            const feedback = feedbackMatch ? feedbackMatch[1].trim() : 'Photo analyzed successfully';

            return {
                rejected:  false,
                total:     Math.min(Math.max(total, 0), 77),
                breakdown: { composition, technical, lighting, creativity },
                feedback,
                maxScore:  77
            };

        } catch (error) {
            console.error('Error parsing Gemini response:', error);
            throw new Error('Failed to parse AI response: ' + error.message);
        }
    }

    extractScore(text, label, maxScore) {
        try {
            const regex = new RegExp(`${label}\\s*(\\d+)\\s*/\\s*\\d+`, 'i');
            const match = text.match(regex);
            if (match && match[1]) {
                return Math.min(Math.max(parseInt(match[1]), 0), maxScore);
            }
            console.warn(`Could not extract score for ${label}, defaulting to 0`);
            return 0;
        } catch (e) {
            return 0;
        }
    }

    detectMimeType(dataUrl) {
        if (dataUrl.includes('data:image/png'))  return 'image/png';
        if (dataUrl.includes('data:image/jpeg')) return 'image/jpeg';
        if (dataUrl.includes('data:image/jpg'))  return 'image/jpeg';
        if (dataUrl.includes('data:image/webp')) return 'image/webp';
        return 'image/jpeg';
    }

    /**
     * 🎭 "Roast My Photo" — sarcastic, funny critique using Gemini
     * @param {string} imageDataUrl - Base64 data URL of the image
     * @returns {Promise<string>} - A funny roast string
     */
    async roastPhoto(imageDataUrl) {
        try {
            this._validateKey();
            const base64Image = imageDataUrl.includes('base64,')
                ? imageDataUrl.split('base64,')[1]
                : imageDataUrl;
            const mimeType = this.detectMimeType(imageDataUrl);

            const roastPrompt = `You are a sarcastic, witty photography critic with a razor-sharp sense of humor. 
Roast this photo in exactly 2 sentences. Be genuinely funny and slightly mean about the photography choices, 
lighting, composition, or subject matter — but keep it playful and NOT mean about any people in the photo.
Focus on technique, not people. Be creative and specific about what's wrong.
Respond with ONLY the 2-sentence roast, nothing else. No preamble, no explanations.`;

            const requestBody = {
                contents: [{ parts: [{ text: roastPrompt }, { inline_data: { mime_type: mimeType, data: base64Image } }] }],
                generationConfig: { temperature: 0.9, maxOutputTokens: 150, topP: 0.95 },
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
                ]
            };

            const response = await fetch(`${this.apiEndpoint}?key=${this.apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            return text.trim() || "Even my roast generator gave up on this one. That's how bad this photo is.";
        } catch (err) {
            console.error('Roast error:', err);
            return "My sarcasm module crashed trying to process this image. That should tell you something.";
        }
    }

    /**
     * ⚡ Check if current time is within "Golden Hour" (5 PM - 7 PM local time)
     */
    static isGoldenHour() {
        const h = new Date().getHours();
        return h >= 17 && h < 19;
    }

    getRatingDescription(score) {
        if (score >= 70) return 'Excellent — Professional quality';
        if (score >= 60) return 'Very Good — Strong photography';
        if (score >= 50) return 'Good — Above average';
        if (score >= 40) return 'Average — Decent photo';
        if (score >= 30) return 'Below Average — Needs improvement';
        if (score >= 20) return 'Poor — Major issues';
        return 'Very Poor — Significant problems';
    }

    generateDetailedFeedback(result) {
        if (result.rejected) {
            return {
                rating:       0,
                description:  'Image Rejected',
                feedback:     result.reason,
                suggestions: [
                    'Please upload a clear photograph',
                    'Avoid screenshots, documents, or blurred images',
                    'Ensure your photo is properly focused and well-lit'
                ]
            };
        }

        const suggestions = [];
        if (result.breakdown.composition < 15) suggestions.push('Try using the rule of thirds for better composition');
        if (result.breakdown.technical   < 12) suggestions.push('Ensure your photo is sharp and in focus');
        if (result.breakdown.lighting    < 10) suggestions.push('Experiment with natural lighting for better results');
        if (result.breakdown.creativity  <  8) suggestions.push('Try unique angles or perspectives');

        return {
            rating:      result.total,
            description: this.getRatingDescription(result.total),
            feedback:    result.feedback,
            breakdown:   result.breakdown,
            suggestions: suggestions.length > 0 ? suggestions : ['Great photo! Keep practicing to improve further.']
        };
    }
}

// Make available globally in browser
if (typeof window !== 'undefined') {
    window.PhotoRatingSystem = PhotoRatingSystem;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PhotoRatingSystem };
}