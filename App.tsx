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
import { sendMessage, registerClientMessageClb, getContacts, updateContacts } from "./firebaseClientUtils";
import { Communications, Communication, ContextQualia } from "./types";
import { Timestamp } from "firebase/firestore";
import { getUserId } from "./firebase";
import { messageListener } from "./server";
import { auth } from "./firebaseAuth";
import { signInAnonymously, linkWithPhoneNumber, RecaptchaVerifier, signInWithPhoneNumber } from "firebase/auth";
import { ai } from "./firebaseAuth";
import * as FileSystem from "expo-file-system";
import { firebaseConfig } from "./firebaseConfig";
import { startAudioSession } from "./audioSession";
import { LiveSession } from "firebase/ai";

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
  type?: string;
  isThought?: boolean;
  contextId?: string;
  contextName?: string;
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
  };
  theme: Theme;
  isTalkingToSelf: boolean;
}

const MessageItem = React.memo(function MessageItem({
  item,
  theme,
  isTalkingToSelf,
}: MessageItemProps) {
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
      <View style={styles.delimiterContainer}>
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
    <View style={styles.messageContainer}>
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
    // For web, inject CSS to hide the reCAPTCHA badge.
    if (Platform.OS === "web") {
      const style = document.createElement("style");
      style.textContent = ".grecaptcha-badge { visibility: hidden !important; }";
      document.head.append(style);
    }
  }, []);

  // State
  const [userQualia, setUserQualia] = useState<ContextQualia | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [isCalling, setIsCalling] = useState(false);
  const webviewRef = useRef<WebView>(null);
  const [liveSession, setLiveSession] = useState<LiveSession | null>(null);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (user) {
        setUserId(user.uid);
      } else {
        setUserId(null);
        // Reset state on sign out
        setUserQualia(null);
        setActiveQualia(null);
        setMessages([]);
        setContacts([]);
      }
    });
    return () => unsubscribe();
  }, []);

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
  const [inputText, setInputText] = useState("");
  const [isSwitcherVisible, setIsSwitcherVisible] = useState(false);

  const handleSignOut = useCallback(() => {
    auth.signOut();
    setIsSwitcherVisible(false);
  }, []);

  const handleCall = async () => {
    if (isCalling) {
      console.log("Ending call.");
      if (Platform.OS === 'web') {
        if (liveSession) {
          liveSession.close();
        }
      } else {
        webviewRef.current?.postMessage('stop');
      }
    } else {
      console.log("Starting call.");
      addMessage("(Call started)", "ui");
      setIsCalling(true);
      if (Platform.OS === 'web') {
        const session = await startAudioSession(
          (type, text) => { // onTranscriptPart
            const isContinuing = lastTranscriptType.current === type;
            addMessage(text, type, { appendToLast: isContinuing });
            lastTranscriptType.current = type;
          },
          (type, text) => { // onTranscriptFlush
            if (type === 'ended') {
              setIsCalling(false);
              setLiveSession(null);
              addMessage("(Call ended)", "ui");
              lastTranscriptType.current = null;
            } else {
              lastTranscriptType.current = null;
              // In future, send `text` to qualia.
            }
          }
        );
        setLiveSession(session);
      } else {
        webviewRef.current?.postMessage('start');
      }
    }
  };

  // Derived State for UI presentation
  const isTalkingToSelf = useMemo(() => {
    return userQualia && activeQualia ? activeQualia.id === userQualia.id : false;
  }, [userQualia, activeQualia]);

  // Refs
  const inputRef = useRef<TextInput>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentIndexRef = useRef(0);
  // Allow null in the ref type so we can safely check before calling instance methods
  const flatListRef = useRef<FlatList<any> | null>(null);

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
  // Adds a message to the history, ensuring the context (activeQualia at the time) is stored.
  // New: optional third parameter `prependIfMatch` will, when true, prepend the new text
  // onto the last message if that message has the same isThought/contextId/contextName.
  const addMessage = useCallback(
    (text: string, fromQualiaId: string, options: { appendToLast?: boolean } = {}) => {
      if (!activeQualia) return;
      if (text.length === 0) return;

      const isThought = fromQualiaId !== activeQualia.id;
      const newMessage: Message = {
        id: Date.now().toString() + Math.random(),
        text,
        isThought,
        contextId: activeQualia.id,
        contextName: activeQualia.name,
      };

      setMessages((prevMessages) => {
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

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];

      // Check if context switched compared to the last message processed
      if (lastContextId !== null && message.contextId !== lastContextId) {
        // Context switch detected. We need the name of the previous context.
        const previousMessage = messages[i - 1];
        if (previousMessage) {
          // Requirement: add a subtle delimiter with name of the previous qualia
          const delimiter = {
            id: `delimiter-${message.id}`,
            type: "delimiter",
            text: `(Context switch from ${previousMessage.contextName})`,
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
          addMessage(message, communication.fromQualiaId);
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

  // Ensure FlatList scrolls to bottom on new messages (using displayMessages which includes delimiters)
  useEffect(() => {
    if (displayMessages.length > 0) {
      // Use optional chaining to avoid calling scrollToEnd on a null ref
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [displayMessages]);

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
              {activeQualia ? activeQualia.name : "Loading..."}
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

        {/* Chat Area */}
        <FlatList
          ref={flatListRef}
          data={displayMessages}
          renderItem={({ item }) => (
            <MessageItem
              item={item}
              theme={theme}
              isTalkingToSelf={isTalkingToSelf}
            />
          )}
          keyExtractor={(item) => item.id}
          style={styles.chatList}
          contentContainerStyle={styles.chatListContent}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
        />

        {/* Input Area */}
        <View style={styles.inputContainer}>
          <TextInput
            ref={inputRef}
            style={[styles.input, { color: theme.text }]}
            value={inputText}
            onChangeText={handleInputChange}
            placeholder="..."
            placeholderTextColor={theme.dimText}
            multiline
            autoFocus={true}
            selectionColor={theme.accent}
            underlineColorAndroid="transparent"
            submitBehavior="newline"
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
      {Platform.OS !== 'web' && userQualia && (
        <WebView
          ref={webviewRef}
          style={{ display: 'none' }}
          source={require('./public/webview/audio.html')}
          injectedJavaScript={`const firebaseConfig = ${JSON.stringify(firebaseConfig)};`}
          onMessage={(event) => {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'user') {
              addMessage(data.message, 'user');
            } else if (data.type === 'gemini') {
              addMessage(data.message, 'gemini');
            } else if (data.type === 'ended') {
              setIsCalling(false);
              addMessage("(Call ended)", "ui");
            }
          }}
        />
      )}
    </SafeAreaView>
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
