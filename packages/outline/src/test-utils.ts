import { EditorSelection, EditorState, Transaction, type StateCommand } from "@codemirror/state";

export interface CommandResult {
  handled: boolean;
  state: EditorState;
  transactions: Transaction[];
  initialState: EditorState;
}

export function positionOf(text: string, needle: string, offset = 0): number {
  const position = text.indexOf(needle);
  if (position < 0) throw new Error(`Missing fixture text: ${needle}`);
  return position + offset;
}

export function runCommand(
  command: StateCommand,
  doc: string,
  selection: number | { anchor: number; head?: number },
): CommandResult {
  let state = EditorState.create({
    doc,
    selection:
      typeof selection === "number"
        ? EditorSelection.cursor(selection)
        : EditorSelection.single(selection.anchor, selection.head ?? selection.anchor),
  });
  const initialState = state;
  const transactions: Transaction[] = [];
  const target = {
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
      transactions.push(transaction);
      state = transaction.state;
    },
  };
  const handled = command(target);
  return { handled, state, transactions, initialState };
}

export function invertText(result: CommandResult): string {
  let state = result.state;
  for (const transaction of result.transactions.toReversed()) {
    state = state.update({ changes: transaction.changes.invert(transaction.startState.doc) }).state;
  }
  return state.doc.toString();
}
