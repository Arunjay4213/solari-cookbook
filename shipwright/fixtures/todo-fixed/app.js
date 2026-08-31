const input = document.querySelector("#new-todo");
const list = document.querySelector("#todo-list");
const empty = document.querySelector("#empty");

const addButton = document.querySelector("#add-btn");

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
