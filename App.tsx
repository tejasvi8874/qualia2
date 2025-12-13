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
import { sendMessage, registerClientMessageClb } from "./firebaseClientUtils";
import { Communications, Communication, ContextQualia } from "./types";
import { serverTimestamp, Timestamp } from "firebase/firestore";
import { getUserId } from "./firebase";
import { messageListener } from "./server";
import { auth } from "./firebaseAuth";
import { signInAnonymously } from "firebase/auth";

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

// Mock Data
const ONBOARDING_QUALIA = {
  id: "q-onboarding",
  name: "Onboarding",
};
const INITIAL_CONTACTS = [
  { id: "q-friend-1", name: "Morgan" },
  { id: "q-base", name: "Base Qualia" },
  ONBOARDING_QUALIA, // Keep Onboarding available
];

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
  const displayText =
    shouldUseThoughtStyle && !item.text.startsWith("(")
      ? `(${item.text})`
      : item.text;

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
}

const QualiaSwitcher = ({
  visible,
  onClose,
  contacts,
  userQualia,
  onAction,
  theme,
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

          {userQualia && (
            <TouchableOpacity
              onPress={() => handleSelect(userQualia)}
              style={styles.switchItem}
            >
              <Text style={[styles.switchItemText, { color: theme.accent }]}>
                {userQualia.name} (Self)
              </Text>
            </TouchableOpacity>
          )}

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
                  {item.name}
                </Text>
              </TouchableOpacity>
            )}
          />
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
};

// --- Main App Component ---

const AppContent = () => {
  const colorScheme = useColorScheme();
  const theme = useMemo(() => getTheme(colorScheme), [colorScheme]);

  useEffect(() => {
    signInAnonymously(auth).then((x) => console.log("signed", x));
  }, []);

  // State
  const [userQualia, setUserQualia] = useState<ContextQualia | null>(null);
  // user id and user name
  const [userName, setUserName] = useState<string| null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    getUserId().then(setUserId);
  }, []);
  const [contacts, setContacts] = useState(INITIAL_CONTACTS);
  const [activeQualia, setActiveQualia] = useState(ONBOARDING_QUALIA);


  const [isThinkingMode, setIsThinkingMode] = useState(false); // False = Speaking

  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [isSwitcherVisible, setIsSwitcherVisible] = useState(false);

  // Derived State for UI presentation
  const isTalkingToSelf = useMemo(() => {
    return userQualia ? activeQualia.id === userQualia.id : false;
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
  const addMessage = useCallback(
    (text: string, isThought: boolean) => {
      const newMessage: Message = {
        id: Date.now().toString() + Math.random(),
        text,
        isThought,
        contextId: activeQualia.id,
        contextName: activeQualia.name,
      };
      setMessages((prevMessages) => [...prevMessages, newMessage]);
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

  // --- Initialization & Onboarding ---

  useEffect(() => {
    // Start the onboarding flow
    if (
      !userQualia &&
      activeQualia.id === ONBOARDING_QUALIA.id &&
      messages.length === 0
    ) {
      setTimeout(() => {
        addMessage("Welcome. I am the Onboarding Qualia.", false);
      }, 500);
      setTimeout(() => {
        // Inform the user that the switcher is disabled
        addMessage(
          "(Your input is transmitted automatically. You cannot switch context until your identity is established. Once established, you can toggle between Speaking and Thinking when talking to others.)",
          true,
        );
      }, 1500);
      setTimeout(() => {
        addMessage(
          "To establish your presence, please tell me your name.",
          false,
        );
      }, 3500);
    }
  }, [userQualia, activeQualia, messages.length, addMessage]);

  // --- Core Logic (Simulated Backend) ---
  useEffect(() => {
    if (!userId) {
      return;
    }
    const unsubscribePromise = registerClientMessageClb(
      (communication: Communication) =>
        Promise.resolve().then(() => {
          let message = communication.message;
          const isThought = communication.fromQualiaId !== activeQualia.id;
          if (isThought) {
            message = `[${communication.fromQualiaName}]: ${communication.message}`;
          }
          addMessage(message, isThought);
        }),
    );
    return () => {
      unsubscribePromise.then((unsub) => unsub());
    };
  }, [userId]);

  const processInput = useCallback(
    async (input: string, contextQualia: ContextQualia, isThinkingInput: boolean) => {
      if (!input || input.trim().length === 0) return;

      // 1. Handle Onboarding Flow Initiation
      if (contextQualia.id === ONBOARDING_QUALIA.id && !userQualia) {
        // First time setup (providing the name)
        const name = input.trim();
        if (name.length > 1) {
          const newUserQualia: ContextQualia = {
            id: await getUserId(),
            name: name,
          };
          setUserQualia(newUserQualia);

          // (Context remains ONBOARDING_QUALIA)

          setTimeout(() => {
            // Onboarding confirms
            addMessage(`Identity recognized. Welcome, ${name}.`, false);
          }, 500);

          setTimeout(() => {
            // Requirement: let own qualia participate in conversation like any other qualia.
            // User Qualia starts participating (its first thought)
            // We use newUserQualia here as the source because userQualia state update is async.
            addMessage(
              `(Consciousness established. I am ${name}. I am observing this interaction.)`,
              true,
            );
          }, 1000);

          setTimeout(() => {
            // Onboarding gives next steps
            addMessage(
              "You can now switch contexts by clicking my name at the top, or continue speaking to me.",
              false,
            );
          }, 2500);
        }
        return;
      }

      // 2. Standard Processing
      if (!userQualia) return; // Safety check (e.g. if user typed before onboarding finished initializing)

      const isSelfContext = contextQualia.id === userQualia.id;

      // Requirement: Talking to own qualia: speaking/thinking is the same
      if (isSelfContext) {
        // Process the input internally by userQualia, regardless of mode.
        setTimeout(() => {
          const reflection = `Processed input: "${input.substring(0, 20)}..."`;
          // Semantically, this is an internal process (thought), but UI will display it normally.
          sendMessage({ toQualia: contextQualia, message: input, contextQualia, });
          addMessage(reflection, true);
        }, 300);
        return;
      }

      // --- Context is External Qualia ---

      // If the input is a thought (Thinking about the external qualia)
      // Requirement: The user qualia then adds more details through thought communication
      if (isThinkingInput) {
        setTimeout(() => {
          // This will be shown stylized as a thought.
          // Tailor the feedback slightly if it's a definition of a new qualia (using the 'q-new-' prefix)
          const thoughtContext = contextQualia.id.startsWith("q-new-")
            ? `Defining ${contextQualia.name}`
            : `Thought recorded regarding ${contextQualia.name}`;

          sendMessage({ toQualia: userQualia, message: input, contextQualia })
          addMessage(
            `(${thoughtContext}. Input: "${input.substring(0, 20)}...")`,
            true,
          );
        }, 300);
        return; // Thoughts do not trigger external responses
      }

      // If the input is spoken (Speaking to the external qualia)

      // User's qualia internal reflection on the communication
      const reflection = `(Transmitting to ${contextQualia.name}: "${input.substring(0, 10)}...".)`;

      if (Math.random() > 0.4) {
        setTimeout(() => {
          // This will be shown stylized as a thought.
          addMessage(reflection, true);
        }, 200);
      }

      // 3. Communication routing (Speaking)
      setTimeout(() => {
        const response = `Acknowledged, ${userQualia.name}. I noted: "${input}".`;
        // This will be shown normally.
        addMessage(response, false);
      }, 1200);
      sendMessage({ toQualia: contextQualia, message: input, contextQualia });
    },
    [userQualia, addMessage],
  );

  // --- Input Handling ---

  const sendChunk = useCallback(
    (chunk: string, thinking: boolean) => {
      if (chunk.trim().length > 0) {
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

    let newIndex = lastSentIndexRef.current;
    // Send chunk if punctuation is detected
    const punctuationMarks = [".", "!", "?", ";", ","];
    if (text && punctuationMarks.includes(text.charAt(text.length - 1))) {
      const chunk = text.substring(lastSentIndexRef.current);
      sendChunk(chunk, isThinkingMode);
      newIndex = text.length;
      lastSentIndexRef.current = newIndex;
    }

    if (text.length > newIndex) {
      // Capture the current mode for the timeout function to ensure robustness
      const currentMode = isThinkingMode;
      timerRef.current = setTimeout(() => {
        finalizeInput(currentMode);
      }, IDLE_TIMEOUT);
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
          true, // It is a thought by the userQualia
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

        // Safety check (Onboarding)
        if (!userQualia && newQualia.id !== ONBOARDING_QUALIA.id) {
          return;
        }

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
              {activeQualia.name}
            </Text>
          </TouchableOpacity>
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
      />
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
    alignItems: "flex-start",
    justifyContent: "center",
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
