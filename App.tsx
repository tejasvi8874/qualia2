import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  Platform,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  useColorScheme,
  Modal,
} from "react-native";
// Import SafeAreaProvider to use in the root and within the Modal
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useAssets } from 'expo-asset';
import { AudioModule } from 'expo-audio';
import { File } from 'expo-file-system';
import { registerClientMessageClb, sendMessage, getContacts, getHistoricalMessages, callCloudFunction } from './firebaseClientUtils';
import { Communication, ContextQualia, QualiaDoc, QualiaDocOperationRecord } from "./types";
import { Timestamp, getDoc, addDoc, writeBatch, doc, query, where, onSnapshot } from "firebase/firestore";
import { messageListener, startIntegrationLoop, getPendingCommunications, getQualiaDocRef, updateContacts, summarizeQualiaDoc, summarizeConversations, summarizeOperations } from "./server";
import { serializeQualia } from "./graphUtils";
import { auth, db } from "./firebaseAuth";
import { communicationsCollection, qualiaDocOperationsCollection } from "./firebase";
import { RecaptchaVerifier, signInWithPhoneNumber, ConfirmationResult, PhoneAuthProvider, signInWithCredential, signInWithCustomToken } from "firebase/auth";
import { firebaseConfig } from "./firebaseConfig";
import { startAudioSession } from "./audioSession";
import { LiveSession } from "firebase/ai";
import { FUNCTION_NAMES } from "./functions/src/shared";
import { BatchProcessor, RateLimiter } from "./requestUtils";

declare global {
  interface Window {
    recaptchaVerifier: RecaptchaVerifier;
  }
}

/*
TODO: optimize get contacts to fetch conversation after the last contact timestamp
TODO: Slow and fast model. Slow model does max thinking.
TODO: Ask to provide shorter responses.
TODO: Fix startup screen. Open up to last/self. Maybe do away with separate onboarding qualia.
TODO: Test speaking/thinking
TODO: Publish website
TODO: Default value of thinking budget? Seems to be -1. Set it to that to be safe.
TODO: Trigger contact sharing when mentioned? Language etc issue. Maybe display an icon to "connect" which can lure users to click and share to remove visual annoyance.
TODO: Suggestion to be cognizant of rate and last timstamp of human responses to detect if your messages are being viewed by a human.
TODO: Clicking an ID triggers a message to that qualia by own qualia using best deducible name
TODO: Encryption? With warning of data loss if key is lost.
TODO: Qualia to gently ask phone number when suitable and send to SYSTEM for verification with OTP. Also after sharing contacts, qualia can contact relevant characters in the chats with the human counterpart.
But you still need a way to login. That you could do in same way in natural language with Qualia but that might feel impersonal.
Maybe a lightweight LLM to login/signup and then hand off to main qualia system.
TODO: security auth rules
TODO: Handle multiple clients listening and generating response
Temporarily store the messages somewhere.
TODO: Add older conversations to qualia
TODO: Refactor out the communication recieving part from the communication processing and generation part
TODO: Problem is can't tell where did I stop reading since the last message. Need some kind of visual break to indicate my typing starts?
Maybe subtle three dot icon which can expand to the sent text?
Fade timeout to force the user to listen more? Force them to be as close as human-human communication?
*/

const IDLE_TIMEOUT = 1500; // 1.5 seconds of inactivity to send remaining input and clear

// Solarized Color Palette
const Colors = {
  base03: "#002b36", // background (dark)
  base01: "#586e75", // emphasized content/dimmed (dark)
  base00: "#657b83", // content (dark)
  base0: "#839496", // content (light)
  base1: "#93a1a1", // emphasized content/dimmed (light)
  base3: "#fdf6e3", // background (light)
  cyan: "#2aa198",
  blue: "#268bd2",
  green: "#859900",
};

const FONT_FAMILY = Platform.select({
  ios: "Georgia",
  android: "serif",
  default: "Georgia",
});

const FONT_SIZE = 18;

type LocalColorScheme = "light" | "dark" | "no-preference" | null | undefined;

interface Theme {
  isDark: boolean;
  background: string;
  text: string;
  dimText: string;
  accent: string;
  createAccent: string;
}

interface Message {
  id: string;
  text: string;
  isThought?: boolean;
  contextId?: string;
  contextName?: string;
  deliveryTime?: Timestamp;
  isInitialHistory?: boolean;
}

const getTheme = (colorScheme: LocalColorScheme): Theme => {
  const isDark = colorScheme === "dark";
  return {
    isDark,
    background: isDark ? Colors.base03 : Colors.base3,
    text: isDark ? Colors.base0 : Colors.base00,
    dimText: isDark ? Colors.base01 : Colors.base1,
    accent: isDark ? Colors.cyan : Colors.blue,
    createAccent: Colors.green,
  };
};



// --- Components ---

interface MessageItemProps {
  item: {
    id: string;
    text: string;
    type?: string;
    isThought?: boolean;
    contextId?: string;
    contextName?: string;
    isInitialHistory?: boolean;
  };
  theme: Theme;
  isTalkingToSelf: boolean;
  hasScrolled: boolean;
}

const MessageItem = React.memo(function MessageItem({
  item,
  theme,
  isTalkingToSelf,
  hasScrolled,
}: MessageItemProps) {
  const isVisible = !item.isInitialHistory || hasScrolled;
  const containerStyle = { opacity: isVisible ? 1 : 0 };
  // Hooks must be called unconditionally at the top level.

  // Handle potential undefined isThought property (e.g., for delimiters) safely.
  const isThought = item.isThought ?? false;

  // When talking to self, responses do not need a distinguished style.
  const shouldUseThoughtStyle = isTalkingToSelf ? false : isThought;

  // useMemo is called before any conditional returns.
  const textStyle = useMemo(
    () => [
      styles.messageText,
      { color: shouldUseThoughtStyle ? theme.dimText : theme.text },
      shouldUseThoughtStyle && styles.thoughtText,
    ],
    [shouldUseThoughtStyle, theme],
  );

  // Handle Delimiter
  if (item.type === "delimiter") {
    return (
      <View style={[styles.delimiterContainer, containerStyle]}>
        <View
          style={[styles.delimiterLine, { backgroundColor: theme.dimText }]}
        />
        <Text style={[styles.delimiterText, { color: theme.dimText }]}>
          {item.text}
        </Text>
        <View
          style={[styles.delimiterLine, { backgroundColor: theme.dimText }]}
        />
      </View>
    );
  }

  // Handle Standard Message

  // Stylize thoughts (when applicable) as italics and slightly dim enclosed in parentheses.
  const text = item.text.trim();
  const displayText =
    shouldUseThoughtStyle && !item.text.startsWith("(")
      ? `(${text})`
      : text;

  return (
    <View style={[styles.messageContainer, containerStyle]}>
      <Text style={textStyle}>{displayText}</Text>
    </View>
  );
});

interface QualiaSwitcherProps {
  visible: boolean;
  onClose: () => void;
  contacts: ContextQualia[];
  userQualia: ContextQualia | null;
  onAction: (
    action: { type: "SWITCH"; qualia: ContextQualia } | { type: "CREATE"; name: string },
  ) => void;
  theme: Theme;
  onSignOut: () => void;
}

const QualiaSwitcher = ({
  visible,
  onClose,
  contacts,
  userQualia,
  onAction,
  theme,
  onSignOut,
}: QualiaSwitcherProps) => {
  const [searchQuery, setSearchQuery] = useState("");
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setSearchQuery("");
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [visible]);

  const filteredContacts = useMemo(() => {
    return contacts
      .slice()
      .sort((a, b) => {
        const timeA = a.lastContactTime?.toMillis() || 0;
        const timeB = b.lastContactTime?.toMillis() || 0;
        return timeB - timeA;
      })
      .filter((contact) =>
        contact.name.toLowerCase().includes(searchQuery.toLowerCase()),
      );
  }, [searchQuery, contacts]);

  const handleSelect = (qualia: ContextQualia) => {
    // Signal switching action
    onAction({ type: "SWITCH", qualia });
    onClose();
  };

  const handleCreate = () => {
    const name = searchQuery.trim();
    // Signal creation action
    if (name && userQualia) {
      onAction({ type: "CREATE", name });
      onClose();
    }
  };

  // Requirement: Create button only works when there is a name in search bar (and user is established).
  const canCreate = userQualia && searchQuery.trim().length > 0;

  return (
    <Modal
      animationType="none"
      transparent={false}
      visible={visible}
      onRequestClose={onClose}
    >
      {/* Modals render outside the main hierarchy. Wrap in SafeAreaProvider. */}
      <SafeAreaProvider>
        <SafeAreaView
          style={[styles.container, { backgroundColor: theme.background }]}
        >
          <View style={styles.switcherHeader}>
            <TextInput
              ref={inputRef}
              style={[
                styles.switcherSearchInput,
                { color: theme.text, backgroundColor: theme.background },
              ]}
              placeholder="Search or Name Qualia..."
              placeholderTextColor={theme.dimText}
              value={searchQuery}
              onChangeText={setSearchQuery}
              selectionColor={theme.accent}
              underlineColorAndroid="transparent"
            />
            <TouchableOpacity
              onPress={handleCreate}
              style={styles.switcherButton}
              disabled={!canCreate}
            >
              <Text
                style={[
                  styles.switcherButtonText,
                  { color: canCreate ? theme.createAccent : theme.dimText },
                ]}
              >
                Create
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} style={styles.switcherButton}>
              <Text
                style={[styles.switcherButtonText, { color: theme.dimText }]}
              >
                Close
              </Text>
            </TouchableOpacity>
          </View>

          <View style={{ flex: 1 }}>
            <FlatList
              data={filteredContacts}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="always"
              scrollEventThrottle={16}
              renderItem={({ item }) => (
                <TouchableOpacity
                  onPress={() => handleSelect(item)}
                  style={styles.switchItem}
                >
                  <Text style={[styles.switchItemText, { color: theme.text }]}>
                    {item.name + (item.id === userQualia?.id ? " (Self)" : "")}
                  </Text>
                </TouchableOpacity>
              )}
            />
          </View>
          <TouchableOpacity onPress={onSignOut} style={styles.signOutButton}>
            <Text style={[styles.switcherButtonText, { color: theme.dimText }]}>
              Logout
            </Text>
          </TouchableOpacity>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
};

// --- Main App Component ---

const AppContent = () => {
  const lastTranscriptType = useRef<'user' | 'gemini' | 'ended' | null>(null);
  const colorScheme = useColorScheme();
  const theme = useMemo(() => getTheme(colorScheme), [colorScheme]);

  useEffect(() => {
    (async () => {
      if (Platform.OS !== 'web') {
        const status = await AudioModule.requestRecordingPermissionsAsync();
        if (!status.granted) {
          console.warn('Permission to access microphone was denied');
        }
      }
    })();
  }, []);

  useEffect(() => {
    // For web, inject CSS to hide the reCAPTCHA badge.
    if (Platform.OS === "web") {
      const style = document.createElement("style");
      style.textContent = ".grecaptcha-badge { visibility: hidden !important; }";
      document.head.append(style);
    }
  }, []);

  if (Platform.OS !== "web") {
    const [assets, error] = useAssets([
      require('./public/audio.bundle'),
      require('./public/auth.bundle'),
    ]);

    useEffect(() => {
      if (assets) {
        const [audioAsset, authAsset] = assets;

        const loadContent = async () => {
          try {
            if (audioAsset?.localUri) {
              const file = new File(audioAsset.localUri);
              const htmlContent = await file.text();
              console.log("loaded audio html");
              setAudioHtml(`<h1>haha<h1><script>${htmlContent}</script>`);
            }

            if (authAsset?.localUri) {
              const file = new File(authAsset.localUri);
              const jsContent = await file.text();
              console.log("loaded auth bundle");
              setAuthHtml(`
<!DOCTYPE html>
<html>
<head>
  <title>Auth Helper</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
    }
    #recaptcha-container {
      width: 100%;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
    }
  </style>
</head>
<body>
  <div id="recaptcha-container"></div>
  <script>${jsContent}</script>
</body>
</html>
            `);
            }
          } catch (e) {
            console.error("Failed to load assets content", e);
          }
        };
        loadContent();
      }
    }, [assets]);
  }

  // State
  const [userQualia, setUserQualia] = useState<ContextQualia | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [isCalling, setIsCalling] = useState(false);
  const isCallingRef = useRef(isCalling);
  useEffect(() => { isCallingRef.current = isCalling; }, [isCalling]);

  const webviewRef = useRef<WebView>(null);
  const authWebViewRef = useRef<WebView>(null);
  const authWebViewReady = useRef(false);
  const audioWebViewReady = useRef(false);
  const pendingAuthCommand = useRef<string | null>(null);
  const pendingAudioCommand = useRef<string | null>(null);
  const [liveSession, setLiveSession] = useState<LiveSession | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");
  const [audioHtml, setAudioHtml] = useState<string>("");
  const [authHtml, setAuthHtml] = useState<string>("");

  const postToAuthWebView = useCallback((payload: object) => {
    const message = JSON.stringify(payload);
    if (authWebViewReady.current && authWebViewRef.current) {
      console.log("sent", message)
      authWebViewRef.current.postMessage(message);
      return true;
    }
    pendingAuthCommand.current = message;
    console.log("Auth component is still loading. Retrying...");
    return false;
  }, []);

  const handleAuthSubmit = useCallback(async () => {
    // Native: trigger WebView-based reCAPTCHA & phone auth
    if (Platform.OS !== "web") {
      if (!inputText.trim()) return;

      // Step 1: ask WebView to send SMS with reCAPTCHA solved inside it
      if (!verificationId) {
        postToAuthWebView({ type: "startPhoneAuth", phoneNumber: inputText.trim() });
        setInputText("");
        return;
      }

      // Step 2: confirm code natively using the verificationId from the WebView
      try {
        const credential = PhoneAuthProvider.credential(
          verificationId,
          inputText.trim(),
        );
        console.log("logging in")
        await signInWithCredential(auth, credential);
        console.log("logged in")
        // setVerificationId(null);
        setInputText("");
      } catch (error: any) {
        console.error("OTP Error:", error);
        alert("Invalid verification code: " + (error?.message || ""));
      }
      return;
    }

    if (!inputText.trim()) return;

    if (!confirmationResult) {
      // Phone Number Step (web with reCAPTCHA)
      try {
        const appVerifier = new RecaptchaVerifier(auth, 'sign-in-button', {
          'size': 'invisible',
          'callback': (response: any) => {
            // reCAPTCHA solved, allow signInWithPhoneNumber.
          }
        });

        const result = await signInWithPhoneNumber(auth, inputText, appVerifier);
        setConfirmationResult(result);
        setInputText("");
      } catch (error: any) {
        console.error("Phone Auth Error:", error);
        alert("Error sending code: " + error.message);
      }
    } else {
      // OTP Step
      try {
        await confirmationResult.confirm(inputText);
        // User signed in. Auth listener will handle the rest.
        setConfirmationResult(null);
        setInputText("");
      } catch (error) {
        console.error("OTP Error:", error);
        alert("Invalid verification code");
      }
    }
  }, [inputText, confirmationResult, verificationId, postToAuthWebView]);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (user) {
        setUserId(user.uid);
        setVerificationId(null);
        setConfirmationResult(null);
      } else {
        setUserId(null);
        // Reset state on sign out
        setUserQualia(null);
        setActiveQualia(null);
        setMessages([]);
        setContacts([]);
        setGraphError(null);
        setVerificationId(null);
      }
    });
    return () => unsubscribe();
  }, []);

  // Start integration loop when user is authenticated
  useEffect(() => {
    if (userId) {
      console.log("Starting integration loop for user:", userId);
      startIntegrationLoop(userId).catch((error) => {
        console.error("Integration loop error:", error);
        setGraphError(error.message || "An error occurred in the integration loop");
      });
    }
  }, [userId]);

  const [contacts, setContacts] = useState<ContextQualia[]>([]);
  const [activeQualia, setActiveQualia] = useState<ContextQualia | null>(null);


  useEffect(() => {
    if (userId) {
      getContacts().then(serverContacts => {
        const contactMap = new Map<string, ContextQualia>();
        serverContacts.forEach(contact => contactMap.set(contact.qualiaId, { id: contact.qualiaId, name: contact.names[0], lastContactTime: contact.lastContactTime }));

        const serverContactsList = Array.from(contactMap.values());
        setContacts(serverContactsList);

        const self = serverContactsList.find(c => c.id === userId);
        if (self) {
          setUserQualia(self);
          setActiveQualia(self);
        } else {
          // New user flow
          const name = window.prompt("Welcome! Please enter your name:");
          if (name) {
            const newUserQualia = { id: userId, name: name, lastContactTime: Timestamp.now() };
            setUserQualia(newUserQualia);
            setActiveQualia(newUserQualia);
            updateContacts([{ qualiaId: userId, names: [name], lastContactTime: Timestamp.now() }]);
          }
        }
      });
    }
  }, [userId]);


  const [isThinkingMode, setIsThinkingMode] = useState(false); // False = Speaking

  const [messages, setMessages] = useState<Message[]>([]);
  const [isSwitcherVisible, setIsSwitcherVisible] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [hasScrolled, setHasScrolled] = useState(false);

  // Derived State for UI presentation
  const isTalkingToSelf = useMemo(() => {
    return userQualia && activeQualia ? activeQualia.id === userQualia.id : false;
  }, [userQualia, activeQualia]);

  const inputRef = useRef<TextInput>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentIndexRef = useRef(0);
  const currentStreamDeliveryTime = useRef<Timestamp | null>(null);
  const [flatListHeight, setFlatListHeight] = useState(0);

  useEffect(() => {
    console.log("Setting up message listener");
    if (userId) {
      const unsubscribe = messageListener();
      return () => {
        unsubscribe.then((unsub) => unsub()).then(() => console.log("Unsubscribed message listener"));
      };
    }
  }, [userId]);

  // --- Message Management ---
  // Adds a message to the history, ensuring the context (activeQualia at the time) is stored.
  // New: optional third parameter `appendToLast` will, when true, prepend the new text
  // onto the last message if that message has the same isThought/contextId/contextName.
  const addMessage = useCallback(
    (text: string, fromQualiaId: string, options: { appendToLast?: boolean, deliveryTime?: Timestamp, id?: string } = {}) => {
      if (!activeQualia) return;
      if (text.length === 0) return;

      const isThought = fromQualiaId !== activeQualia.id;
      const newMessage: Message = {
        id: options.id || Date.now().toString() + Math.random(),
        text,
        isThought,
        contextId: activeQualia.id,
        contextName: activeQualia.name,
        deliveryTime: options.deliveryTime || Timestamp.now(),
      };

      setMessages((prevMessages) => {
        // Check for duplicates
        if (prevMessages.some(m => m.id === newMessage.id)) {
          return prevMessages;
        }

        if (options.appendToLast && prevMessages.length > 0) {
          const last = prevMessages[prevMessages.length - 1];

          const { id: lastId, text: lastText, ...lastRest } = last;
          const { id: newId, text: newText, ...newRest } = newMessage;

          if (JSON.stringify(lastRest) === JSON.stringify(newRest)) {
            const mergedText = last.text + newMessage.text;
            const mergedMessage = { ...last, text: mergedText };
            return [...prevMessages.slice(0, -1), mergedMessage];
          }
        }

        return [...prevMessages, newMessage];
      });
    },
    [activeQualia],
  );

  // Process messages to include delimiters when context switches in the history.
  const displayMessages = useMemo(() => {
    const items = [];
    let lastContextId = null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];

      // Check if context switched compared to the last message processed
      if (lastContextId !== null && message.contextId !== lastContextId) {
        // Context switch detected. We need the name of the previous context.
        const previousMessage = messages[i + 1];
        if (previousMessage) {
          // Requirement: add a subtle delimiter with name of the previous qualia
          const delimiter = {
            id: `delimiter-${message.id}`,
            type: "delimiter",
            text: `(Context switch from ${previousMessage.contextName} ${lastContextId} ${JSON.stringify(message.contextId)}, ${JSON.stringify(previousMessage.contextId)})`,
          };
          items.push(delimiter);
        }
      }
      items.push(message);
      lastContextId = message.contextId;
    }
    return items;
  }, [messages]);

  // --- Core Logic ---
  useEffect(() => {
    if (!userId) {
      return;
    }
    console.log("Setting up display message listener");
    const unsubscribePromise = registerClientMessageClb(
      (communication: Communication) =>
        Promise.resolve().then(() => {
          if (!activeQualia) return;
          let message = communication.message;
          console.log("Got message: ", JSON.stringify(communication).substring(0, 100));
          const isThought = communication.fromQualiaId !== activeQualia.id;
          if (isThought) {
            message = `[${communication.fromQualiaName}]: ${communication.message}`;
          }
          addMessage(message, communication.fromQualiaId, { deliveryTime: communication.deliveryTime, id: communication.id });
        }),
    );
    return () => {
      unsubscribePromise.then((unsub) => unsub()).then(() => {
        console.log("Unsubscribed display message listener");
      });
    };
  }, [userId, activeQualia, addMessage]);

  const processInput = useCallback(
    async (input: string, contextQualia: ContextQualia, isThinkingInput: boolean) => {
      if (!input || input.trim().length === 0 || !userQualia) return;

      const isSelfContext = contextQualia.id === userQualia.id;

      // Requirement: Talking to own qualia: speaking/thinking is the same
      if (isSelfContext) {
        // Process the input internally by userQualia, regardless of mode.
        sendMessage({ toQualia: contextQualia, message: input, contextQualia, });
        return;
      }

      // --- Context is External Qualia ---

      // If the input is a thought (Thinking about the external qualia)
      // Requirement: The user qualia then adds more details through thought communication
      if (isThinkingInput) {
        sendMessage({ toQualia: userQualia, message: input, contextQualia })
        return; // Thoughts do not trigger external responses
      }

      // If the input is spoken (Speaking to the external qualia)
      sendMessage({ toQualia: contextQualia, message: input, contextQualia });
    },
    [userQualia, addMessage],
  );

  // --- Input Handling ---

  const sendChunk = useCallback(
    (chunk: string, thinking: boolean) => {
      if (chunk.trim().length > 0 && activeQualia) {
        processInput(chunk.trim(), activeQualia, thinking);
      }
    },
    [processInput, activeQualia],
  );

  // finalizeInput accepts the mode explicitly to handle asynchronous state updates robustly
  const finalizeInput = useCallback(
    (mode: boolean) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      setInputText((currentText) => {
        const remainingChunk = currentText.substring(lastSentIndexRef.current);
        // Use the explicitly passed mode
        sendChunk(remainingChunk, mode);
        lastSentIndexRef.current = 0;
        return "";
      });
    },
    [sendChunk],
  );

  const handleInputChange = (text: string) => {
    if (!userId) {
      setInputText(text);
      return;
    }

    // Enter key toggles mode only if user is established AND not talking to self
    if (text.endsWith("\n") && userQualia && !isTalkingToSelf) {
      toggleMode();
      return;
    }

    setInputText(text);

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    // Send chunk if punctuation is detected
    const punctuationMarks = [".", "!", "?", ";", ","];
    if (text && punctuationMarks.includes(text.charAt(text.length - 1))) {
      const chunk = text.substring(lastSentIndexRef.current);
      sendChunk(chunk, isThinkingMode);
      lastSentIndexRef.current = text.length;
    }

    // If there is any text in the input, set a timer to finalize it after a delay.
    // This ensures that even after sending a chunk on punctuation, the input will
    // eventually be cleared.
    if (text.length > 0) {
      const currentMode = isThinkingMode;
      timerRef.current = setTimeout(() => {
        finalizeInput(currentMode);
      }, IDLE_TIMEOUT);
    } else {
      // If the input is empty (e.g., user deleted everything), reset the index.
      lastSentIndexRef.current = 0;
    }
  };

  // --- UI Interaction Handlers ---

  const toggleMode = useCallback(() => {
    // Should not be callable if talking to self or pre-onboarding, but check defensively.
    if (!userQualia || isTalkingToSelf) return;

    // Finalize using the current mode BEFORE toggling the state
    finalizeInput(isThinkingMode);

    setIsThinkingMode((prevMode) => !prevMode);

    // Requirement: Preserve keyboard focus in the input box.
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [userQualia, finalizeInput, isThinkingMode, isTalkingToSelf]);

  const fetchHistory = useCallback(async () => {
    if (!activeQualia || isLoadingHistory) return;

    if (!activeQualia?.name) {
      throw new Error("No active qualia" + JSON.stringify(activeQualia));
    }
    console.log("Fetching history...");
    setIsLoadingHistory(true);

    const oldestMessage = messages[0];
    const before = oldestMessage?.deliveryTime || Timestamp.now();

    try {
      const historicalMessages = await getHistoricalMessages(before, 10);
      if (historicalMessages.length > 0) {
        const newMessages = historicalMessages.map((msg) => ({
          ...msg,
          id: msg.id || `${msg.deliveryTime?.toMillis()}-${Math.random()}`,
          text: msg.message,
          isThought: msg.fromQualiaId !== activeQualia?.id,
          contextId: activeQualia?.id,
          contextName: activeQualia?.name,
          isInitialHistory: isInitialLoad,
        }));
        setMessages((prev) => {
          const existingIds = new Set(prev.map(m => m.id));
          const uniqueNewMessages = newMessages.filter(m => !existingIds.has(m.id));
          return [...uniqueNewMessages, ...prev];
        });
      }
    } catch (error) {
      console.error("Error fetching historical messages:", error);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [messages, isLoadingHistory, activeQualia, isInitialLoad]);

  useEffect(() => {
    // Fetch initial message history when the active qualia is set
    if (activeQualia && isInitialLoad) {
      fetchHistory();
      setIsInitialLoad(false);
    }
  }, [activeQualia, isInitialLoad, fetchHistory]);

  const handleSignOut = useCallback(() => {
    auth.signOut();
    setIsSwitcherVisible(false);
  }, []);

  const onTranscriptPart = useCallback((type: 'user' | 'gemini', text: string) => {
    let content = text;
    if (type === 'user' && content && content === content.toUpperCase() && /[a-zA-Z]/.test(content)) {
      content = content.charAt(0).toUpperCase() + content.slice(1).toLowerCase();
    }

    const isContinuing = lastTranscriptType.current === type;
    if (!isContinuing) {
      currentStreamDeliveryTime.current = Timestamp.now();
    }
    addMessage(content, type === 'user' ? (userQualia?.id || 'user') : (activeQualia?.id || 'gemini'), {
      appendToLast: isContinuing,
      deliveryTime: currentStreamDeliveryTime.current || Timestamp.now()
    });
    lastTranscriptType.current = type;
  }, [userQualia, activeQualia, addMessage]);

  const pendingUserCommunication = useRef<Communication | null>(null);

  const onTranscriptFlush = useCallback(async (type: 'user' | 'gemini' | 'ended', text: string) => {
    console.log("trascript flush", { type, text })
    if (type === 'ended') {
      setIsCalling(false);
      setLiveSession(null);
      addMessage("(Call ended)", "ui");
      lastTranscriptType.current = null;
      currentStreamDeliveryTime.current = null;

      // Flush any pending user communication
      if (pendingUserCommunication.current) {
        addDoc(await communicationsCollection(), pendingUserCommunication.current);
        pendingUserCommunication.current = null;
      }
    } else {
      lastTranscriptType.current = null;
      currentStreamDeliveryTime.current = null;

      // Persist transcript
      if (activeQualia && userQualia) {
        let content = text;
        if (type === 'user' && content && content === content.toUpperCase() && /[a-zA-Z]/.test(content)) {
          content = content.charAt(0).toUpperCase() + content.slice(1).toLowerCase();
        }

        const deliveryTime = Timestamp.now();
        if (type === 'user') {
          const communication: Communication = {
            fromQualiaId: userQualia.id,
            fromQualiaName: userQualia.name,
            toQualiaId: activeQualia.id,
            toQualiaName: activeQualia.name,
            message: content,
            communicationType: "HUMAN_TO_QUALIA",
            ack: false,
            seen: true,
            deliveryTime: deliveryTime,
            context: "audio call"
          };
          // Store for batching
          pendingUserCommunication.current = communication;
        } else if (type === 'gemini') {
          const batch = writeBatch(db);
          const collection = await communicationsCollection();

          // Add pending user communication if exists
          if (pendingUserCommunication.current) {
            const userDocRef = doc(collection);
            batch.set(userDocRef, pendingUserCommunication.current);
            pendingUserCommunication.current = null;
          }

          const communication: Communication = {
            fromQualiaId: activeQualia.id,
            fromQualiaName: activeQualia.name,
            toQualiaId: userQualia.id,
            toQualiaName: userQualia.name,
            message: text,
            communicationType: "QUALIA_TO_HUMAN",
            ack: false,
            seen: true,
            deliveryTime: deliveryTime,
            context: "audio call"
          };
          const geminiDocRef = doc(collection);
          batch.set(geminiDocRef, communication);

          await batch.commit();
        }
      }
    }
  }, [activeQualia, userQualia, addMessage]);

  const startAudio = async (systemInstruction?: string) => {
    if (Platform.OS === 'web') {
      const session = await startAudioSession(
        onTranscriptPart,
        onTranscriptFlush,
        systemInstruction
      );
      setLiveSession(session);
    } else {
      const user = auth.currentUser;
      if (!user) {
        console.log("Not authenticated; cannot start call.");
        setIsCalling(false);
        return;
      }
      console.log("sent message")
      let idToken;
      try {
        idToken = await callCloudFunction(FUNCTION_NAMES.GET_CUSTOM_TOKEN, {});
        console.log("Got custom token:", idToken);
      } catch (e) {
        console.error("Error getting custom token:", e);
        throw e;
      }
      console.log("Loggin in with token ", idToken)
      const startMsg = JSON.stringify({ type: 'start', systemInstruction, idToken });
      if (audioWebViewReady.current && webviewRef.current) {
        webviewRef.current.postMessage(startMsg);
      } else {
        pendingAudioCommand.current = startMsg;
      }
    }
  };

  const stopAudio = () => {
    if (Platform.OS === 'web') {
      if (liveSession) {
        liveSession.close();
      }
    } else {
      const stopMsg = JSON.stringify({ type: 'stop' });
      if (audioWebViewReady.current && webviewRef.current) {
        webviewRef.current.postMessage(stopMsg);
      } else {
        pendingAudioCommand.current = stopMsg;
      }
    }
  };

  const handleCall = async () => {
    if (isCalling) {
      console.log("Ending call.");
      stopAudio();
    } else {
      console.log("Starting call.");
      addMessage("(Call started)", "ui");
      setIsCalling(true);

      // Fetch context
      let systemInstruction: string | undefined = undefined;
      if (activeQualia) {
        try {
          const qualiaDocRef = await getQualiaDocRef(activeQualia.id);
          const qualiaDocSnap = await getDoc(qualiaDocRef);
          const qualiaDoc = qualiaDocSnap.data() as QualiaDoc;
          const pendingCommunications = await getPendingCommunications(activeQualia.id);
          const qualiaDocSummary = summarizeQualiaDoc(qualiaDoc);
          const convSummary = summarizeConversations(pendingCommunications, qualiaDocSummary);

          systemInstruction = `You are a qualia.\n\nNote: You may receive user messages indicating your subconscious thoughts. These are your own internal realizations and NOT dialogue from the user. These thoughts might or might not affect subsequent conversation with the user and do NOT directly reference these thoughts or ANY other subconscious thoughts in your response in any way. The user provided thoughts will end with (end subconscious thoughts).\n\nHere is your memory and context:\n${JSON.stringify({ myQualiaId: activeQualia.id, memorySummary: qualiaDocSummary, recentConversationsSummary: convSummary, money: 100 })}`;
          console.log("System instruction prepared with context:", systemInstruction);
        } catch (e) {
          console.error("Failed to fetch context for audio session:", e);
        }
      }

      if (Platform.OS === 'web') {
        const session = await startAudioSession(
          onTranscriptPart,
          onTranscriptFlush,
          systemInstruction
        );
        setLiveSession(session);
      } else {
        await startAudio(systemInstruction);
      }
    }
  };








  // Subconscious Thoughts Injection
  useEffect(() => {
    if (!isCalling || !activeQualia || !userId) return;

    let unsubscribe: (() => void) | undefined;
    let isActive = true;

    const setupListener = async () => {
      try {
        const collection = await qualiaDocOperationsCollection();
        if (!isActive) return;

        // Initialize BatchProcessor
        const batchProcessor = new BatchProcessor<QualiaDocOperationRecord>(
          new RateLimiter(3, "SubconsciousThoughts"), // Use a separate rate limiter or share one? Sharing might be better if global limit matters.
          async (batch) => {
            if (!isActive) return;
            // Flatten operations from all records in the batch
            const allOperations = batch.flatMap(record => record.operations);
            if (allOperations.length === 0) return;

            try {
              // Fetch the latest QualiaDoc for context
              const qualiaDocRef = await getQualiaDocRef(activeQualia.id);
              const qualiaDocSnap = await getDoc(qualiaDocRef);
              const qualiaDoc = qualiaDocSnap.data() as QualiaDoc;

              const summary = await summarizeOperations(allOperations, summarizeQualiaDoc(qualiaDoc));
              if (summary) {
                if (!isCallingRef.current) {
                  console.log("Call ended, skipping subconscious thought injection");
                  return;
                }
                const message = `(your subconscious thoughts):\n${summary}\n(end subconscious thoughts)`;
                console.log("Injecting subconscious thought:", message);
                if (Platform.OS === 'web') {
                  liveSession?.send(message);
                } else {
                  const sendMsg = JSON.stringify({ type: 'send', message });
                  if (audioWebViewReady.current && webviewRef.current) {
                    webviewRef.current.postMessage(sendMsg);
                  }
                }
              }
            } catch (e) {
              console.error("Error processing subconscious thoughts batch:", e);
            }
          },
          "SubconsciousThoughtsBatcher"
        );

        // Listen for operations created after the call started
        // We use a timestamp to ensure we only get NEW operations that weren't included in the initial system prompt
        const callStartTime = Timestamp.now();
        const q = query(
          collection,
          where("qualiaId", "==", activeQualia.id),
          where("qualiaDocId", ">", ""),
          where("createdTime", ">", callStartTime)
        );

        const unsub = onSnapshot(q, async (snapshot) => {
          if (!isActive) return;
          for (const change of snapshot.docChanges()) {
            if (change.type === "added") {
              const data = change.doc.data() as QualiaDocOperationRecord;
              // Only process if it has a qualiaDocId (successful operation)
              if (data.qualiaDocId) {
                console.log("Queueing subconscious thoughts from operation:", change.doc.id);
                batchProcessor.add(data);
              }
            }
          }
        });

        if (isActive) {
          unsubscribe = unsub;
        } else {
          unsub();
        }
      } catch (e) {
        console.error("Error setting up subconscious thoughts listener:", e);
      }
    };

    setupListener();

    return () => {
      isActive = false;
      if (unsubscribe) unsubscribe();
    };
  }, [isCalling, activeQualia, userId, liveSession]);

  // Handles the creation flow logic
  const createAndSwitchToQualia = useCallback(
    (name: string) => {
      if (!userQualia) return;

      // 1. Finalize pending input
      finalizeInput(isThinkingMode);

      // 2. Create the new Qualia object
      const newQualia: ContextQualia = {
        id: `q-new-${Date.now()}`, // Prefix helps identify newly created qualia in processInput
        name: name,
        lastContactTime: Timestamp.now(),
      };

      // 3. Add to contacts
      setContacts((prevContacts) => [...prevContacts, newQualia]);

      // 4. Switch context to the new Qualia
      setActiveQualia(newQualia);

      // 5. Requirement: switches to it in thinking mode.
      setIsThinkingMode(true);

      // 6. Add initial context message
      setTimeout(() => {
        addMessage(
          `(Entity "${name}" created. You are now in Thinking mode. Define its characteristics or switch to Speaking mode.)`,
          "ui", // It is a thought by the userQualia
        );
      }, 100);

      // 7. Autofocus
      setTimeout(() => inputRef.current?.focus(), 100);
    },
    [userQualia, finalizeInput, isThinkingMode, addMessage],
  );

  // Handler for actions from the switcher (unified CREATE and SWITCH)
  interface SwitchQualiaAction {
    type: "SWITCH";
    qualia: ContextQualia;
  }

  interface CreateQualiaAction {
    type: "CREATE";
    name: string;
  }

  type SwitcherAction = SwitchQualiaAction | CreateQualiaAction;

  const handleSwitcherAction = useCallback(
    (action: SwitcherAction) => {
      if (action.type === "CREATE") {
        createAndSwitchToQualia(action.name);
      } else if (action.type === "SWITCH") {
        const newQualia = action.qualia;
        if (!newQualia) return;

        // Standard switch logic
        finalizeInput(isThinkingMode);
        setActiveQualia(newQualia);
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    },
    [userQualia, isThinkingMode, finalizeInput, createAndSwitchToQualia],
  );

  const handleOpenSwitcher = () => {
    // Requirement: Disable QualiaSwitcher until userQualia is established
    if (userQualia) {
      setIsSwitcherVisible(true);
    }
  };

  const modeText = isThinkingMode ? "Thinking" : "Speaking";

  return (
    // SafeAreaView ensures content is below the status bar/notch and clickable on all platforms
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.background }]}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.container}
      >
        {/* Header */}
        <View style={styles.header}>
          {/* Disable the button functionally until userQualia is established */}
          <TouchableOpacity onPress={handleOpenSwitcher} disabled={!userQualia}>
            {/* Dim the text slightly when disabled for better UX */}
            <Text
              style={[
                styles.headerTitle,
                { color: userQualia ? theme.text : theme.dimText },
              ]}
            >
              {activeQualia ? activeQualia.name : "Intro"}
            </Text>
          </TouchableOpacity>
          {userQualia && (
            <TouchableOpacity onPress={handleCall}>
              <Text style={[styles.headerTitle, { color: isCalling ? theme.createAccent : theme.text }]}>
                {isCalling ? "End" : "Call"}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Graph Error Banner */}
        {graphError && (
          <View style={[styles.errorBanner, { backgroundColor: '#ff4444' }]}>
            <Text style={[styles.errorText, { color: '#ffffff' }]}>
              Graph Error: {graphError}
            </Text>
            <TouchableOpacity onPress={() => setGraphError(null)} style={styles.errorDismiss}>
              <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: 'bold' }}>×</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Chat Area */}
        <FlatList
          data={displayMessages}
          renderItem={({ item, index }) => (
            <MessageItem
              item={item}
              theme={theme}
              isTalkingToSelf={isTalkingToSelf}
              hasScrolled={hasScrolled}
            />
          )}
          keyExtractor={(item) => item.id}
          style={styles.chatList}
          contentContainerStyle={styles.chatListContent}
          keyboardShouldPersistTaps="handled"
          inverted
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (!isLoadingHistory) {
              fetchHistory();
            }
          }}
          onScroll={() => {
            if (!hasScrolled) {
              setHasScrolled(true);
            }
          }}
          overScrollMode="always"
          showsVerticalScrollIndicator={false}
          // ListHeaderComponent={<View style={{ height: flatListHeight }} />}
          onLayout={(event) => {
            console.log("height", event.nativeEvent.layout.height)
            setFlatListHeight(event.nativeEvent.layout.height);
          }}
        />

        {/* Input Area */}
        <View style={styles.inputContainer}>
          <TextInput
            ref={inputRef}
            style={[styles.input, { color: theme.text }]}
            value={inputText}
            onChangeText={handleInputChange}
            placeholder={
              !userId
                ? (Platform.OS === "web"
                  ? (!confirmationResult ? "Enter Phone Number (+1...)" : "Enter Code")
                  : (!verificationId ? "Enter Phone Number (+1...)" : "Enter Code"))
                : "..."
            }
            placeholderTextColor={theme.dimText}
            multiline={!!userId}
            autoFocus={true}
            selectionColor={theme.accent}
            underlineColorAndroid="transparent"
            submitBehavior={userId ? "newline" : "submit"}
            keyboardType={
              !userId
                ? ((Platform.OS === "web"
                  ? (!confirmationResult ? "phone-pad" : "number-pad")
                  : (!verificationId ? "phone-pad" : "number-pad")))
                : "default"
            }
            textContentType={
              !userId
                ? ((Platform.OS === "web"
                  ? (!confirmationResult ? "telephoneNumber" : "oneTimeCode")
                  : (!verificationId ? "telephoneNumber" : "oneTimeCode")))
                : "none"
            }
            autoComplete={
              !userId
                ? ((Platform.OS === "web"
                  ? (!confirmationResult ? "tel" : "sms-otp")
                  : (!verificationId ? "tel" : "sms-otp")))
                : undefined
            }
            returnKeyType={!userId ? "done" : "default"}
            onSubmitEditing={!userId ? handleAuthSubmit : undefined}
          />
          {/* Requirement: Don't show thinking/speaking toggle when talking to own qualia. 
              Also hide until userQualia is established. */}
          {userQualia && !isTalkingToSelf && (
            <TouchableOpacity
              onPress={toggleMode}
              style={styles.modeToggle}
              // Prevent keyboard dismissal on iOS when tapping the button
              onPressIn={
                Platform.OS === "ios" ? (e) => e.preventDefault() : undefined
              }
            >
              <Text style={[styles.modeToggleText, { color: theme.dimText }]}>
                {modeText}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>

      <QualiaSwitcher
        visible={isSwitcherVisible}
        onClose={() => setIsSwitcherVisible(false)}
        contacts={contacts}
        userQualia={userQualia}
        onAction={handleSwitcherAction}
        theme={theme}
        onSignOut={handleSignOut}
      />
      <View nativeID="sign-in-button" />
      {Platform.OS !== 'web' && !userQualia && !verificationId && authHtml && (
        <View
          style={{
            width: '100%', height: 500,
            position: 'absolute', top: 100, left: 0,
            borderColor: 'red',
            borderWidth: 10,
            // opacity: 0.1,
          }}
        >
          <WebView
            ref={authWebViewRef}
            source={{ html: authHtml, baseUrl: 'https://localhost' }}
            injectedJavaScriptBeforeContentLoaded={`window.firebaseConfig = ${JSON.stringify(firebaseConfig)}; true;`}
            onMessage={(event) => {
              console.log("Auth WebView message received", event.nativeEvent.data);
              try {
                const raw = event.nativeEvent.data;
                const data = typeof raw === "string"
                  ? (() => { try { return JSON.parse(raw); } catch { return { type: "raw", message: raw }; } })()
                  : raw;
                if (data.type === 'verificationId') {
                  setVerificationId(data.verificationId || null);
                } else if (data.type === 'authError') {
                  console.log(`Auth Error: ${data.message || 'Unknown error'}`);
                } else if (data.type === 'log') {
                  console.log("Auth WebView:", data.message);
                } else if (data.type === 'raw') {
                  console.log("Auth WebView raw:", data.message);
                } else if (data.type === 'ready') {
                  authWebViewReady.current = true;
                  if (pendingAuthCommand.current && authWebViewRef.current) {
                    authWebViewRef.current.postMessage(pendingAuthCommand.current);
                    pendingAuthCommand.current = null;
                  }
                }
              } catch (e) {
                console.error("Auth WebView parse error", e);
              }
            }}
            onLoad={() => {
              authWebViewReady.current = true;
              if (pendingAuthCommand.current && authWebViewRef.current) {
                authWebViewRef.current.postMessage(pendingAuthCommand.current);
                pendingAuthCommand.current = null;
              }
            }}
            originWhitelist={["*"]}
          />
        </View>)}
      {Platform.OS !== 'web' && userQualia && audioHtml && (
        <WebView
          ref={webviewRef}
          style={{ position: 'absolute', width: 100, height: 100, borderWidth: 10, borderColor: 'red', opacity: 100, top: 0, left: 0 }}
          source={{ html: audioHtml, baseUrl: 'https://localhost' }}
          injectedJavaScriptBeforeContentLoaded={`window.firebaseConfig = ${JSON.stringify(firebaseConfig)}; true;`}
          onMessage={(event) => {
            const raw = event.nativeEvent.data;
            let data: any;
            try {
              data = typeof raw === "string" ? JSON.parse(raw) : raw;
            } catch (err) {
              console.warn("Audio WebView message parse failed", err, raw);
              return;
            }
            if (data.type === 'user') {
              onTranscriptFlush('user', data.message);
            } else if (data.type === 'gemini') {
              onTranscriptFlush('gemini', data.message);
            } else if (data.type === 'ended') {
              onTranscriptFlush('ended', '');
              setIsCalling(false);
            } else if (data.type === 'log') {
              console.log("Audio WebView:", data.message);
            } else if (data.type === 'ready') {
              audioWebViewReady.current = true;
              if (pendingAudioCommand.current && webviewRef.current) {
                webviewRef.current.postMessage(pendingAudioCommand.current);
                pendingAudioCommand.current = null;
              }
            } else if (data.type === 'authError') {
              console.log(`Audio Auth Error: ${data.message || 'Unknown error'}`);
            }
          }}
          onLoad={() => {
            audioWebViewReady.current = true;
            if (pendingAudioCommand.current && webviewRef.current) {
              webviewRef.current.postMessage(pendingAudioCommand.current);
              pendingAudioCommand.current = null;
            }
          }}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false}
          mediaCapturePermissionGrantType="grant"
          originWhitelist={["*"]}
        />
      )}
    </SafeAreaView >
  );
};

// --- Styles ---

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // Typography (Global)
  headerTitle: {
    fontSize: 20,
    fontFamily: FONT_FAMILY,
  },
  messageText: {
    fontSize: FONT_SIZE,
    lineHeight: FONT_SIZE * 1.5,
    fontFamily: FONT_FAMILY,
  },
  thoughtText: {
    fontStyle: "italic",
  },
  modeToggleText: {
    fontSize: 16,
    fontFamily: FONT_FAMILY,
    fontStyle: "italic",
  },

  // Layout
  header: {
    paddingTop: 10,
    paddingBottom: 15,
    paddingHorizontal: 15,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  chatList: {
    flex: 1,
  },
  chatListContent: {
    paddingHorizontal: 15,
    paddingTop: 10,
    paddingBottom: 20,
  },
  messageContainer: {
    marginBottom: 12,
    alignItems: "flex-start",
  },
  // Delimiter Styles (Subtle visualization)
  delimiterContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 25,
  },
  delimiterLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    opacity: 0.6,
  },
  delimiterText: {
    fontSize: 14,
    fontFamily: FONT_FAMILY,
    fontStyle: "italic",
    marginHorizontal: 15,
    opacity: 0.8,
  },

  inputContainer: {
    flexDirection: "row",
    paddingHorizontal: 15,
    paddingTop: 10,
    paddingBottom: Platform.OS === "android" ? 10 : 0,
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    fontSize: FONT_SIZE,
    fontFamily: FONT_FAMILY,
    paddingVertical: 4,
    paddingHorizontal: 0,
    borderWidth: 0,
    ...(Platform.OS === "web" && ({ outlineStyle: "none" } as any)),
    maxHeight: FONT_SIZE * 6,
  },
  modeToggle: {
    marginLeft: 15,
    paddingBottom: 4,
  },

  // Switcher Styles
  switcherHeader: {
    flexDirection: "row",
    padding: 15,
    alignItems: "center",
  },
  switcherSearchInput: {
    flex: 1,
    fontSize: FONT_SIZE,
    fontFamily: FONT_FAMILY,
    padding: 0,
    borderWidth: 0,
    ...(Platform.OS === "web" && ({ outlineStyle: "none" } as any)),
  },
  switcherButton: {
    marginLeft: 15,
  },
  switcherButtonText: {
    fontSize: 16,
    fontFamily: FONT_FAMILY,
  },
  switchItem: {
    paddingVertical: 15,
    paddingHorizontal: 20,
  },
  switchItemText: {
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
  },
  signOutButton: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    alignItems: "center",
  },
  errorBanner: {
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  errorText: {
    flex: 1,
    fontSize: 14,
    fontFamily: FONT_FAMILY,
  },
  errorDismiss: {
    paddingLeft: 12,
  },
});

// Wrap AppContent with SafeAreaProvider at the root
const App = () => {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
};

export default App;
