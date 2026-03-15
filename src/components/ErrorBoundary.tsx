/**
 * ErrorBoundary — catches rendering errors and displays a friendly message
 * instead of crashing the entire CLI.
 */
import React from "react";
import { Box, Text } from "ink";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error?: Error;
  errorInfo?: React.ErrorInfo;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {};
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log to stderr for debugging
    console.error("Uncaught exception in UI:", error);
    console.error(errorInfo.componentStack);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.error) {
      return (
        <Box flexDirection="column" padding={2}>
          <Text color="red">❌ An unexpected error occurred</Text>
          <Text>{this.state.error.message}</Text>
          {this.state.errorInfo && (
            <Text dimColor>
              {this.state.errorInfo.componentStack?.slice(0, 200)}...
            </Text>
          )}
          <Text dimColor>Please restart the application.</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
