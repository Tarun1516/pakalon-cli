# Composition Patterns Skill

This skill provides advanced composition patterns for building flexible, reusable components.

---

## Overview

**Name:** composition-patterns

**Description:** Use advanced composition patterns for building flexible, reusable components. Includes compound components, render props, hooks composition, and state machines.

**When to use:**
- Building component libraries
- Creating flexible UI systems
- Implementing compound components
- Designing composition-heavy interfaces
- Managing complex state

---

## Patterns

### 1. Compound Components

Components that work together and share state implicitly.

```typescript
// Parent manages state
function ToggleGroup({ children, value, onChange }) {
  return (
    <ToggleGroupContext.Provider value={{ value, onChange }}>
      {children}
    </ToggleGroupContext.Provider>
  );
}

// Children access shared state
function ToggleGroupItem({ value, children }) {
  const { value: selectedValue, onChange } = useContext(ToggleGroupContext);
  return (
    <button
      onClick={() => onChange(value)}
      data-selected={selectedValue === value}
    >
      {children}
    </button>
  );
}
```

**Use when:** Building reusable component libraries with flexible APIs.

### 2. Render Props

Sharing code between components using a prop whose value is a function.

```typescript
function DataFetcher({ url, render }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(url).then(r => r.json()).then(d => {
      setData(d);
      setLoading(false);
    });
  }, [url]);

  return render({ data, loading });
}

// Usage
<DataFetcher url="/api/data" render={({ data, loading }) =>
  loading ? <Spinner /> : <List items={data} />
} />
```

**Use when:** Reusable logic with flexible rendering.

### 3. Custom Hooks

Extracting and reusing stateful logic.

```typescript
function useToggle(initial = false) {
  const [value, setValue] = useState(initial);
  const toggle = useCallback(() => setValue(v => !v), []);
  return [value, toggle, setValue];
}

// Usage
function Switch() {
  const [on, toggle] = useToggle();
  return <button onClick={toggle}>{on ? 'ON' : 'OFF'}</button>;
}
```

**Use when:** Sharing stateful logic between components.

### 4. State Machines (XState)

Explicit state management with defined transitions.

```typescript
const fetchMachine = {
  id: 'fetch',
  initial: 'idle',
  states: {
    idle: {
      on: { FETCH: 'loading' }
    },
    loading: {
      on: { SUCCESS: 'success', ERROR: 'failure' }
    },
    success: {
      on: { RESET: 'idle' }
    },
    failure: {
      on: { RETRY: 'loading' }
    }
  }
};
```

**Use when:** Complex state with clear transitions and guards.

### 5. Container/Presenter Pattern

Separating logic from rendering.

```typescript
// Container: manages data and logic
function UserListContainer() {
  const [users, setUsers] = useState([]);

  useEffect(() => {
    api.getUsers().then(setUsers);
  }, []);

  return <UserListPresenter users={users} />;
}

// Presenter: only renders
function UserListPresenter({ users }) {
  return (
    <ul>
      {users.map(u => <li key={u.id}>{u.name}</li>)}
    </ul>
  );
}
```

**Use when:** Clean separation of concerns needed.

### 6. Provider Pattern

Global state with context.

```typescript
const ThemeContext = createContext();

function ThemeProvider({ children }) {
  const [theme, setTheme] = useState('dark');

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
```

**Use when:** Multiple components need access to shared state.

---

## When to Use Each Pattern

| Pattern | Use Case |
|---------|----------|
| Compound Components | Reusable UI libraries |
| Render Props | Reusable logic + flexible UI |
| Custom Hooks | Shared stateful logic |
| State Machines | Complex, explicit state |
| Container/Presenter | Separation of concerns |
| Provider Pattern | Global/shared state |

---

## Best Practices

1. **Start simple**: UseState/useEffect first
2. **Extract when repeated**: Don't over-engineer
3. **Consider testability**: Patterns should make testing easier
4. **Document patterns**: Team should understand chosen approaches
5. **Be consistent**: Pick patterns and stick with them

---

## Related Skills

- **react-best-practices**: React fundamentals
- **frontend-design**: Aesthetic implementation

---

*This skill is applied during Phase 3 subagent 1 and 3 implementations.*
