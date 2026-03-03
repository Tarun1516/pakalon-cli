# React Native Skills

This skill provides guidance for building production-ready React Native mobile applications.

---

## Overview

**Name:** react-native-skills

**Description:** Build production-ready React Native applications with proper navigation, native modules, and platform-specific patterns.

**When to use:**
- Building mobile apps
- iOS/Android specific implementations
- Mobile performance optimization
- Native module integration

---

## Core Skills

### Navigation
- React Navigation v6+
- Stack navigators
- Tab navigators
- Drawer navigators
- Deep linking

### Native Modules
- Writing native iOS modules (Swift)
- Writing native Android modules (Kotlin)
- TurboModules
- Legacy Bridge modules

### Platform-Specific Code
- Platform-specific components
- Platform.select() usage
- Native device APIs

### Performance
- FlatList optimization
- Image caching
- Virtualization
- Memory management

### Accessibility
- Mobile accessibility patterns
- Screen reader support
- Gesture handling

---

## Best Practices

### Project Structure
```
src/
├── components/
├── screens/
├── navigation/
├── hooks/
├── services/
├── store/
└── utils/
```

### State Management
- React Context for global state
- useReducer for complex state
- Zustand or Jotai for global state
- React Query for server state

### Navigation
- Type-safe navigation with TypeScript
- Deep linking configuration
- Nested navigators

### Performance
- Use `React.memo` strategically
- Optimize FlatList with getItemLayout
- Lazy load screens
- Optimize images with proper sizing

---

## iOS Specific

### Podfile Configuration
```ruby
platform :ios, '14.0'
use_frameworks!

target 'MyApp' do
  pod 'React', :path => '../node_modules/react-native'
  pod 'SomeNativeModule', :path => './NativeModules'
end
```

### Swift Integration
- Create local CocoaPod
- Use RCT_EXPORT_MODULE
- Handle thread safety

---

## Android Specific

### build.gradle
```gradle
android {
    compileSdkVersion 34
    defaultConfig {
        minSdkVersion 24
    }
}
```

### Kotlin Integration
- Create native module as Kotlin class
- @ReactMethod for JS-callable methods
- Handle promise returns

---

## Testing

### Unit Testing
- Jest for logic testing
- Testing library for components

### E2E Testing
- Detox for E2E tests
- Appium as alternative

---

## Related Skills

- **react-best-practices**: React fundamentals
- **frontend-design**: UI aesthetics

---

*This skill is applied when building React Native mobile applications.*
