/**
 * Todo store slice — in-session task list per Claude Code standard.
 *
 * T-A20: Implement TodoRead / TodoWrite tools
 *
 * Claude can read and update todos during a session.
 * Todos are stored in session state and rendered in TUI as a collapsible sidebar panel.
 */

import { StateCreator } from "zustand";

export interface TodoItem {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed";
	priority: "high" | "medium" | "low";
	createdAt: string;
	updatedAt: string;
}

export interface TodoState {
	todos: TodoItem[];
	showTodos: boolean;
	// Actions
	addTodo: (content: string, priority?: "high" | "medium" | "low") => string;
	updateTodo: (id: string, updates: Partial<Omit<TodoItem, "id" | "createdAt">>) => void;
	removeTodo: (id: string) => void;
	toggleTodoStatus: (id: string) => void;
	getTodos: () => TodoItem[];
	setShowTodos: (show: boolean) => void;
	clearCompleted: () => void;
}

export const createTodoSlice: StateCreator<
	TodoState,
	[],
	[],
	TodoState
> = (set, get) => ({
	todos: [],
	showTodos: false,

	addTodo: (content: string, priority: "high" | "medium" | "low" = "medium") => {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const newTodo: TodoItem = {
			id,
			content,
			status: "pending",
			priority,
			createdAt: now,
			updatedAt: now,
		};
		set((state) => ({ todos: [...state.todos, newTodo] }));
		return id;
	},

	updateTodo: (id: string, updates: Partial<Omit<TodoItem, "id" | "createdAt">>) => {
		set((state) => ({
			todos: state.todos.map((t) =>
				t.id === id
					? { ...t, ...updates, updatedAt: new Date().toISOString() }
					: t
			),
		}));
	},

	removeTodo: (id: string) => {
		set((state) => ({
			todos: state.todos.filter((t) => t.id !== id),
		}));
	},

	toggleTodoStatus: (id: string) => {
		set((state) => ({
			todos: state.todos.map((t) =>
				t.id === id
					? {
							status: t.status === "completed" ? "pending" : "completed",
							updatedAt: new Date().toISOString(),
					  }
					: t
			),
		}));
	},

	getTodos: () => get().todos,

	setShowTodos: (show: boolean) => {
		set({ showTodos: show });
	},

	clearCompleted: () => {
		set((state) => ({
			todos: state.todos.filter((t) => t.status !== "completed"),
		}));
	},
});
