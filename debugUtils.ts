import { Platform } from 'react-native';
import { useState, useEffect } from 'react';

export interface LogEntry {
  id: string;
  timestamp: number;
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  message: string;
}

const MAX_LOGS = 1000;
const logs: LogEntry[] = [];
const listeners: (() => void)[] = [];
const statusListeners: ((enabled: boolean) => void)[] = [];
export let isLogCaptureEnabled = false;

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
  debug: console.debug,
};

const truncate = (str: string, maxLength: number = 1000) => {
  if (str.length <= maxLength) return str;
  const half = maxLength / 2;
  return str.substring(0, half) + '...[truncated]...' + str.substring(str.length - half);
};

const addLog = (level: LogEntry['level'], args: any[]) => {
  if (!isLogCaptureEnabled) return;

  const message = args.map(arg => {
    try {
      if (arg instanceof Error) {
        return arg.toString() + '\n' + arg.stack;
      }
      return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
    } catch (e) {
      return '[Circular/Error]';
    }
  }).join(' ');

  const truncatedMessage = truncate(message, 1000); // 500 start + 500 end

  logs.push({
    id: Date.now().toString() + Math.random(),
    timestamp: Date.now(),
    level,
    message: truncatedMessage,
  });

  if (logs.length > MAX_LOGS) {
    logs.shift();
  }

  listeners.forEach(l => l());
};

let isInitialized = false;

export const initLogCapture = () => {
  if (isInitialized) return;
  if (Platform.OS !== 'web') return;

  isInitialized = true;

  console.log = (...args) => {
    originalConsole.log(...args);
    addLog('log', args);
  };
  console.warn = (...args) => {
    originalConsole.warn(...args);
    addLog('warn', args);
  };
  console.error = (...args) => {
    originalConsole.error(...args);
    addLog('error', args);
  };
  console.info = (...args) => {
    originalConsole.info(...args);
    addLog('info', args);
  };
  console.debug = (...args) => {
    originalConsole.debug(...args);
    addLog('debug', args);
  };

  // Capture unhandled errors if possible (window.onerror)
  if (typeof window !== 'undefined') {
    const originalOnError = window.onerror;
    window.onerror = (message, source, lineno, colno, error) => {
      addLog('error', [`Global Error: ${message} at ${source}:${lineno}:${colno}`, error]);
      if (originalOnError) originalOnError(message, source, lineno, colno, error);
    };

    const originalOnUnhandledRejection = window.onunhandledrejection;
    window.onunhandledrejection = (event) => {
      addLog('error', ['Unhandled Rejection:', event.reason]);
      if (originalOnUnhandledRejection) originalOnUnhandledRejection.call(window, event);
    };
  }
};

export const enableLogCapture = () => {
  isLogCaptureEnabled = true;
  statusListeners.forEach(l => l(true));
  addLog('info', ['Debug mode enabled. Logs are now being recorded.']);
};

export const useLogCaptureStatus = () => {
  const [enabled, setEnabled] = useState(isLogCaptureEnabled);
  useEffect(() => {
    const listener = (s: boolean) => setEnabled(s);
    statusListeners.push(listener);
    return () => {
      const index = statusListeners.indexOf(listener);
      if (index > -1) statusListeners.splice(index, 1);
    };
  }, []);
  return enabled;
};

export const useLogs = () => {
  const [currentLogs, setCurrentLogs] = useState(logs);

  useEffect(() => {
    const listener = () => setCurrentLogs([...logs]);
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index > -1) listeners.splice(index, 1);
    };
  }, []);

  return currentLogs;
};
