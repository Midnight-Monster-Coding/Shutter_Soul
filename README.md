# 📸 Shutter Soul

> **Capture. Compete. Connect. Conquer.**  
> A gamified photography challenge platform and real-time social network combining automated visual evaluation, perceptual image verification, and peer-to-peer WebRTC communication.

---

## 🌟 Overview

**Shutter Soul** is an interactive photography ecosystem designed to encourage daily creative consistency while connecting visual creators. Photographers submit one original capture daily, undergo automated composition and authenticity scoring, accumulate community engagement, and climb competitive monthly leaderboards[cite: 1]. 

Beyond competition, Shutter Soul includes an integrated communication hub featuring real-time messaging and peer-to-peer WebRTC voice/video calls.

---

## ✨ Key Features

### 🏆 Daily Competition & Gamified Leaderboards
* **Daily Challenge Limit:** Submissions are capped at one original photo per creator every 24 hours (max 10MB; JPG, PNG, WebP)[cite: 1].
* **Monthly Reset Cycle:** Leaderboards refresh on the 1st of every month, awarding permanent Gold, Silver, and Bronze trophy medals to the top 3 photographers[cite: 1].
* **Community Engagement Multipliers:** Creators earn extra bonus rating points whenever the community likes and engages with their submissions[cite: 1].

### 🧠 Visual Scoring & Verification Engine
* **Multi-Factor Evaluation:** Analyzes core attributes including rule-of-thirds composition, exposure quality, color grading balance, and structural clarity[cite: 1].
* **Anti-Plagiarism & Duplicate Detection:** Employs client-side perceptual hashing (`perceptual-hash.js`) to reject duplicate submissions, downloaded stock images, and unoriginal media[cite: 1].

### 💬 Real-Time Chat & WebRTC Calling
* **Instant Direct Messaging:** Low-latency 1-on-1 text communication backed by real-time database syncing.
* **Peer-to-Peer Voice & Video Calls:** Low-latency WebRTC data and media channels for crisp audio/video calls without intermediary streaming servers.
* **Presence & Activity Tracking:** Dynamic user availability indicators and real-time push alerts powered by service workers (`firebase-messaging-sw.js`).

---

## 📊 Evaluation & Scoring Matrix

Submissions are evaluated out of a baseline **77-point AI score**, boosted dynamically through peer recognition[cite: 1]:

| Metric | Max Base Points | Criteria Evaluated |
| :--- | :---: | :--- |
| **Composition & Balance**[cite: 1] | **25 pts**[cite: 1] | Rule of thirds, framing, symmetry, visual leading lines[cite: 1] |
| **Technical Quality**[cite: 1] | **20 pts**[cite: 1] | Sharpness, focal accuracy, ISO noise levels, exposure depth[cite: 1] |
| **Color & Lighting**[cite: 1] | **17 pts**[cite: 1] | Dynamic range, highlight recovery, chromatic harmony[cite: 1] |
| **Originality & Diversity**[cite: 1] | **15 pts**[cite: 1] | Perspective uniqueness, framing variety, creative style[cite: 1] |
| **Community Likes**[cite: 1] | **Dynamic Boost**[cite: 1] | Cumulative upvotes and community peer appreciation[cite: 1] |

---

## 🛠️ Architecture & Tech Stack

* **Frontend:** Modern JavaScript (ES6+), HTML5 Canvas, Responsive CSS
* **Backend & Cloud Infrastructure:** Firebase (Firestore Realtime Database, Cloud Storage, Authentication, Firebase Hosting)
* **Real-Time Communication:** WebRTC (RTCPeerConnection, MediaStream API) & Firebase Cloud Messaging (FCM)
* **Image Integrity:** Client-side Perceptual Hashing (pHash) algorithms for visual fingerprinting and duplicate suppression

---

## 📂 Project Structure

```text
Shutter_Soul/
├── public/
│   ├── cleanup-duplicates.html     # Redundant image mitigation utility
│   ├── firebase-messaging-sw.js    # Background push notification worker
│   ├── index.html / index.js       # Main feed & daily competition showcase
│   ├── info.html / info2.html      # Platform guidelines & scoring breakdown
│   ├── login.html                  # Authentication entry point
│   ├── message.html / message.js   # Real-time chat & WebRTC video calling hub
│   ├── perceptual-hash.js          # Fingerprint duplicate hashing logic
│   ├── profile.html                # User showcase, medal case & submission logs
│   └── ranking.html                # Global live leaderboard & monthly standings
├── .gitignore
├── firebase.json                   # Firebase deployment configuration
└── README.md 
