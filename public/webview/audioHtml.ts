export const audioHtml = `<!DOCTYPE html>
<!-- Parallel mobile implementation in audioSession.ts -->
<html>

<head>
    <title>Audio Session</title>
</head>

<body>
    <script>
        const post2 = (payload) => window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        const log3 = (message) => post({ type: 'log', message });

        log3("HaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHaHa")
        log3(\`\${{
            w: window.AudioWorkletNode,
            AudioContext,
            navigator,
            md: navigator.mediaDevices
        }}\`)
    </script>
    <script type="module">
        import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
        import { getAuth, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
        import { getAI, getLiveGenerativeModel, startAudioConversation, GoogleAIBackend } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-ai.js";
        // This script is self-contained and runs inside the native WebView.
        // It receives the firebaseConfig and an ID token via injection/messages from App.tsx.
        const post = (payload) => window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        const log = (message) => post({ type: 'log', message });

        // Early readiness ping so the host knows we loaded, even if init fails.
        post({ type: 'ready' });

        let auth;
        let ai;
        try {
            const app = initializeApp(firebaseConfig);
            auth = getAuth(app);
            ai = getAI(app, { backend: new GoogleAIBackend() });
            log("Audio WebView initialized");
        } catch (err) {
            post({ type: 'authError', message: err?.message || 'Audio init failed' });
        }

        async function ensureSignedIn(idToken) {
            if (!idToken) {
                post({ type: 'authError', message: 'Missing idToken' });
                return;
            }
            if (auth.currentUser) {
                log("Already signed in");
                return;
            }
            try {
                // Best-effort: reuse provided token. If it is not a custom token, this may fail; we still proceed.
                log(\`Signing in with provided token \${idToken}\`);
                const creds = await signInWithCustomToken(auth, idToken);
                log(\`Signed in with provided token: \${creds}\`);
            } catch (error) {
                log(\`Sign-in with provided token failed: \${error?.message || error}\`);
                post({ type: 'authError', message: error?.message || 'Failed to sign in' });
                throw error;
            }
        }

        let liveSession;

        async function startAudioConversationWithInstruction(systemInstruction, idToken) {
            log("Waiting for sign in")
            await ensureSignedIn(idToken);
            log("Signed in, starting audio session")
            log(JSON.stringify(getLiveGenerativeModel));
            let model;
            try {
                model = getLiveGenerativeModel(ai, {
                    model: "gemini-live-2.5-flash-preview",
                    systemInstruction: systemInstruction,
                    generationConfig: {
                        // inputAudioTranscription: {},
                        // outputAudioTranscription: {},
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: {
                                    voiceName: "Aoede"
                                }
                            }
                        },
                    }
                });
            } catch (error) {
                log(\`Failed to start audio session: \${error?.message || error}\`);
                post({ type: 'audioError', message: error?.message || 'Failed to start audio session' });
                throw error;
            }

            log("Connecting to audio session")
            liveSession = await model.connect();
            // Note: In the WebView, we don't need the controller return value.
            log("Starting audio conversation")
            try {
                log(JSON.stringify({
                    w: window.AudioWorkletNode,
                    a: window.AudioContext,
                    b: navigator,
                    md: navigator.mediaDevices
                }))
                await startAudioConversation(liveSession);
            }
            catch (error) {
                log(\`Failed to start audio conversation: \${error?.message || error}\`);
                post({ type: 'audioError', message: error?.message || 'Failed to start audio conversation' });
                throw error;
            }
            liveSession.send("tell a short story")
            log("Started audio conversation")
            receiveMessages(liveSession);
        }

        async function receiveMessages(session) {
            const messageStream = session.receive();
            const userTranscription = [];
            const modelTranscription = [];
            let userFlushTimeout = null;
            let modelFlushTimeout = null;

            const postMessage = (type, message) => {
                window.ReactNativeWebView.postMessage(JSON.stringify({ type, message }));
            };

            const flushUser = () => {
                if (userFlushTimeout) clearTimeout(userFlushTimeout);
                userFlushTimeout = null;
                if (userTranscription.length > 0) {
                    postMessage('user', userTranscription.join(""));
                    userTranscription.length = 0;
                }
            };
            const flushModel = () => {
                if (modelFlushTimeout) clearTimeout(modelFlushTimeout);
                modelFlushTimeout = null;
                if (modelTranscription.length > 0) {
                    postMessage('gemini', modelTranscription.join(""));
                    modelTranscription.length = 0;
                }
            };

            try {
                for await (const message of messageStream) {
                    if (message.type === 'serverContent') {
                        if (message.inputTranscription?.text) {
                            flushModel();
                            userTranscription.push(message.inputTranscription.text);
                            if (userFlushTimeout) clearTimeout(userFlushTimeout);
                            userFlushTimeout = setTimeout(flushUser, 1000);
                        }
                        if (message.outputTranscription?.text) {
                            flushUser();
                            modelTranscription.push(message.outputTranscription.text);
                            if (modelFlushTimeout) clearTimeout(modelFlushTimeout);
                            modelFlushTimeout = setTimeout(flushModel, 1000);
                        }
                        if (message.turnComplete) {
                            flushUser();
                            flushModel();
                        }
                    }
                }
            } finally {
                flushUser();
                flushModel();
                postMessage('ended', '');
            }
        }

        window.addEventListener('message', event => {
            try {
                log("Audio WebView received message", { event });
                // Handle both string and object messages
                const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;

                if (data.type === 'start') {
                    startAudioConversationWithInstruction(data.systemInstruction, data.idToken);
                } else if (data.type === 'stop') {
                    if (liveSession) {
                        liveSession.close();
                    }
                }
            } catch (e) {
                log(\`Error processing message: \${e?.message || e}\`);
                if (event.data === 'stop') {
                    if (liveSession) {
                        liveSession.close();
                    }
                }
            }
        });
        // Signal readiness to the host app
        post({ type: 'ready' });
    </script>
</body>

</html>`;
