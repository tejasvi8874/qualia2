## Overview

This is a React Native application built with Expo and TypeScript. It uses Firebase for backend services, including Firestore for the database, Authentication, and Firebase AI for generative AI features. The application is a chat interface that allows users to communicate with different "qualia" (AI personalities).

## Key Concepts

- **Qualia**: These are AI personalities that the user can interact with. Each qualia has its own context and conversation history.
- **Thinking vs. Speaking**: The user can interact with a qualia in two modes: "thinking" and "speaking".
  - **Speaking**: The message is sent directly to the other qualia.
  - **Thinking**: The message is a "thought" that is processed by the user's own qualia, allowing for internal monologue and planning before communicating with another qualia.
- **Compaction**: To manage the size of conversation histories, a "compaction" process is run on the backend. This process uses a generative model to summarize the conversation and create a new, smaller document representing the state of the qualia.

## Project Structure

- `App.tsx`: The main React Native component that renders the chat interface and manages the application state.
- `firebase.ts`, `firebaseAuth.ts`, `firebaseClientUtils.ts`: These files handle the integration with Firebase services.
- `server.ts`: This file contains the core backend logic that runs in a cloud environment (likely Firebase Functions). It handles message processing, interaction with the generative AI model, and the compaction process.
- `types.ts`: Defines the TypeScript types for the data structures used throughout the application.
- `constants.js`: Contains constant values used in the application.

## Developer Workflows

- **Running the application**: Use the standard Expo commands:
  - `npx expo start`: Starts the development server.
  - `npx expo start --android`: Runs the app on an Android emulator or device.
  - `npx expo start --ios`: Runs the app on an iOS emulator or device.
  - `npx expo start --web`: Runs the app in a web browser.

## Backend Logic

The backend logic is primarily in `server.ts`. The `messageHandler` function is triggered when a new message is added to the `communications` collection in Firestore. It performs the following steps:

1.  Retrieves the relevant "qualia" document.
2.  Constructs a prompt for the generative AI model based on the current conversation context and the new message.
3.  Calls the generative AI model to get a response.
4.  Processes the response and adds new messages to the `communications` collection.
5.  Updates contact information.

The `qualiaCompaction` function is responsible for reducing the size of the qualia documents. It is triggered when a document exceeds a certain size and uses a generative model to create a summarized version of the conversation.

## Code Conventions

- **TypeScript**: The project uses TypeScript for static typing. Be sure to add types for all new variables and functions.
- **Firebase**: The application is tightly integrated with Firebase. Familiarize yourself with the Firebase SDKs for Firestore and Authentication.
- **React Hooks**: The frontend is built with React and makes extensive use of hooks for state management and side effects.
- **State Management**: The main application state is managed within the `App.tsx` component using `useState` and `useReducer`.
