const input = document.querySelector("#new-todo");
const list = document.querySelector("#todo-list");
const empty = document.querySelector("#empty");

// Deliberate bug for stub mode: the markup uses id="add-btn", so this lookup
// returns null and the optional call below binds nothing. Clicking Add does
// nothing, and no console error is raised, so only an E2E click catches it.
const addButton = document.querySelector("#addBtn");

function render() {
  empty.hidden = list.children.length > 0;
}

function addTodo() {
  const text = input.value.trim();
  if (!text) return;

  const item = document.createElement("li");
  item.className = "list__item";

  const label = document.createElement("span");
  label.className = "list__text";
  label.textContent = text;
  label.addEventListener("click", () => item.classList.toggle("is-done"));

  const remove = document.createElement("button");
  remove.className = "list__remove";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    item.remove();
    render();
  });

  item.append(label, remove);
  list.append(item);

  input.value = "";
  input.focus();
  render();
}

addButton?.addEventListener("click", addTodo);

render();
