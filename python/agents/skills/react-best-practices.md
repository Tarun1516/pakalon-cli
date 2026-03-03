# React Best Practices Skill

This skill applies React best practices for component architecture, state management, performance optimization, and modern hooks usage.

---

## Overview

**Name:** react-best-practices

**Description:** Apply React best practices for component architecture, state management, performance optimization, and modern hooks usage.

**When to use:**
- Building React applications
- Optimizing React performance
- Implementing proper state management
- Adding accessibility features

---

## Core Guidelines

### Functional Components
- Always use functional components with hooks
- Prefer `function` declarations over arrow functions for components

### Composition over Inheritance
- Use composition patterns to reuse logic
- Leverage custom hooks for shared logic

### Component Structure
- Keep components small and focused (single responsibility)
- Extract reusable parts into separate components
- Use prop drilling only when necessary, prefer context for global state

### TypeScript
- Use proper TypeScript types for all props
- Avoid `any` type
- Use generics when creating reusable components

### Error Handling
- Implement proper error boundaries
- Handle loading and error states

### Performance
- Use `useMemo` for expensive computations
- Use `useCallback` for callback props
- Implement virtualization for long lists
- Lazy load components with `React.lazy`

### Accessibility
- Use semantic HTML
- Add proper ARIA labels
- Ensure keyboard navigation works
- Test with screen readers

### Modern React 19 Patterns
- Use Server Components where applicable
- Leverage `use` hook for async resources
- Use `useOptimistic` for optimistic UI updates
- Follow new React 19 best practices

---

## Common Patterns

### Custom Hooks
```typescript
function useLocalStorage(key: string, initialValue: T) {
  const [value, setValue] = useState(() => {
    if (typeof window === 'undefined') return initialValue;
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : initialValue;
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}
```

### Compound Components
```typescript
function Menu({ children }) {
  const [activeIndex, setActiveIndex] = useState(0);

  return (
    <MenuContext.Provider value={{ activeIndex, setActiveIndex }}>
      {children}
    </MenuContext.Provider>
  );
}
```

### Render Props
```typescript
function MouseTracker({ render }) {
  const [position, setPosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handler = (e) => setPosition({ x: e.clientX, y: e.clientY });
    window.addEventListener('mousemove', handler);
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  return render(position);
}
```

---

## What to Avoid

- **Large components**: Break into smaller pieces
- **useEffect dependencies issues**: Always include all used values
- **Unnecessary re-renders**: Memoize components and callbacks
- **Inline functions in JSX**: Define outside or memoize
- **Missing keys in lists**: Always provide stable keys

---

## Related Skills

- **frontend-design**: For aesthetic implementation
- **composition-patterns**: For advanced patterns

---

*This skill is applied during Phase 3 subagent 1 and 2 implementations.*
