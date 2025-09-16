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
import { registerCallback, sendMessage } from "./firebase";

// --- Configuration & Constants ---
enum SelfCommunicationType {
  HUMAN_TO_QUALIA,
  QUALIA_TO_HUMAN,
  QUALIA_TO_QUALIA,
}
interface CommunicationT {
  reasoning: string;
  fromQualiaId: string;
  toQualiaId: string;
  isNewQualia: boolean;
  money: number;
  message: string;
  selfCommunicationType: SelfCommunicationType;
  delay: number;
}

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

const getTheme = (colorScheme) => {
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
  frecency: 1,
};
const INITIAL_CONTACTS = [
  { id: "q-friend-1", name: "Morgan", frecency: 10 },
  { id: "q-base", name: "Base Qualia", frecency: 5 },
  ONBOARDING_QUALIA, // Keep Onboarding available
];

// --- Components ---

const MessageItem = React.memo(({ item, theme, isTalkingToSelf }) => {
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

// Uses a unified 'onAction' prop to handle switching and creation
const QualiaSwitcher = ({
  visible,
  onClose,
  contacts,
  userQualia,
  onAction,
  theme,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const inputRef = useRef(null);

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
      )
      .sort((a, b) => (b.frecency || 0) - (a.frecency || 0));
  }, [searchQuery, contacts]);

  const handleSelect = (qualia) => {
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

  // State
  const [userQualia, setUserQualia] = useState(null);
  const [contacts, setContacts] = useState(INITIAL_CONTACTS);
  const [activeQualia, setActiveQualia] = useState(ONBOARDING_QUALIA);

  const [isThinkingMode, setIsThinkingMode] = useState(false); // False = Speaking

  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  const [isSwitcherVisible, setIsSwitcherVisible] = useState(false);

  // Derived State for UI presentation
  const isTalkingToSelf = useMemo(() => {
    return userQualia && activeQualia.id === userQualia.id;
  }, [userQualia, activeQualia]);

  // Refs
  const inputRef = useRef(null);
  const timerRef = useRef(null);
  const lastSentIndexRef = useRef(0);
  const flatListRef = useRef(null);

  // --- Message Management ---

  // Adds a message to the history, ensuring the context (activeQualia at the time) is stored.
  const addMessage = useCallback((text, isThought) => {
    const newMessage = {
      id: Date.now().toString() + Math.random(),
      text,
      isThought,
    };
    setMessages((prevMessages) => [...prevMessages, newMessage]);
  }, []);

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
  registerCallback(({ communication }: { communication: CommunicationT }) => {
    addMessage(
      communication.message,
      communication.fromQualiaId !== activeQualia.id,
    );
  });

  const processInput = useCallback(
    (input, contextQualia, isThinkingInput) => {
      if (!input || input.trim().length === 0) return;

      // 1. Handle Onboarding Flow Initiation
      if (contextQualia.id === ONBOARDING_QUALIA.id && !userQualia) {
        // First time setup (providing the name)
        const name = input.trim();
        if (name.length > 1) {
          const newUserQualia = { id: `user-${Date.now()}`, name: name };
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
          sendMessage(input);
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

          sendMessage(input, contextQualia.id);
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
    },
    [userQualia, addMessage],
  );

  // --- Input Handling ---

  const sendChunk = useCallback(
    (chunk, thinking) => {
      if (chunk.trim().length > 0) {
        processInput(chunk.trim(), activeQualia, thinking);
      }
    },
    [processInput, activeQualia],
  );

  // finalizeInput accepts the mode explicitly to handle asynchronous state updates robustly
  const finalizeInput = useCallback(
    (mode) => {
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

  const handleInputChange = (text) => {
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
    if (text.endsWith(" ")) {
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
    (name) => {
      if (!userQualia) return;

      // 1. Finalize pending input
      finalizeInput(isThinkingMode);

      // 2. Create the new Qualia object
      const newQualia = {
        id: `q-new-${Date.now()}`, // Prefix helps identify newly created qualia in processInput
        name: name,
        frecency: 1,
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
  const handleSwitcherAction = useCallback(
    (action) => {
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
    if (flatListRef.current && displayMessages.length > 0) {
      setTimeout(() => flatListRef.current.scrollToEnd({ animated: true }), 50);
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
            blurOnSubmit={false}
            showsVerticalScrollIndicator={false}
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
    ...(Platform.OS === "web" && { outlineStyle: "none" }),
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
    ...(Platform.OS === "web" && { outlineStyle: "none" }),
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
      <script src="https://www.gstatic.com/firebasejs/ui/6.0.1/firebase-ui-auth.js"></script>
      <link
        type="text/css"
        rel="stylesheet"
        href="https://www.gstatic.com/firebasejs/ui/6.0.1/firebase-ui-auth.css"
      />
    </SafeAreaProvider>
  );
};

export default App;
