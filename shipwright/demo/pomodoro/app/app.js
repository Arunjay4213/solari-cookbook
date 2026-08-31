(() => {
  'use strict';

  const modes = {
    focus: {
      minutes: 25,
      title: 'Time to focus',
      description: 'Choose one task and give it your full attention.',
      startLabel: 'Start focus'
    },
    short: {
      minutes: 5,
      title: 'Take a breath',
      description: 'Step away for a moment and let your mind reset.',
      startLabel: 'Start break'
    },
    long: {
      minutes: 15,
      title: 'Recharge fully',
      description: 'You earned a longer pause. Move, hydrate, and unwind.',
      startLabel: 'Start break'
    }
  };

  const timeDisplay = document.querySelector('#time-display');
  const timerState = document.querySelector('#timer-state');
  const timerRing = document.querySelector('#timer-ring');
  const startButton = document.querySelector('#start-button');
  const startLabel = document.querySelector('#start-label');
  const resetButton = document.querySelector('#reset-button');
  const skipButton = document.querySelector('#skip-button');
  const modeTitle = document.querySelector('#mode-title');
  const modeDescription = document.querySelector('#mode-description');
  const modeButtons = [...document.querySelectorAll('.mode-button')];
  const statusRegion = document.querySelector('#status-region');
  const taskForm = document.querySelector('#task-form');
  const taskInput = document.querySelector('#task-input');
  const taskList = document.querySelector('#task-list');
  const taskCount = document.querySelector('#task-count');
  const emptyState = document.querySelector('#empty-state');
  const soundToggle = document.querySelector('#sound-toggle');
  const themeToggle = document.querySelector('#theme-toggle');

  let activeMode = 'focus';
  let totalSeconds = modes.focus.minutes * 60;
  let remainingSeconds = totalSeconds;
  let intervalId = null;
  let running = false;
  let soundEnabled = false;
  let taskTotal = 0;
  let statusTimer = null;

  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function renderTimer() {
    timeDisplay.textContent = formatTime(remainingSeconds);
    const percent = totalSeconds ? (remainingSeconds / totalSeconds) * 100 : 0;
    timerRing.style.setProperty('--progress', `${percent}%`);
    timerRing.setAttribute('aria-valuemax', String(totalSeconds));
    timerRing.setAttribute('aria-valuenow', String(remainingSeconds));
    timerRing.setAttribute('aria-label', `${activeMode === 'focus' ? 'Focus' : 'Break'} time remaining`);
    document.title = `${formatTime(remainingSeconds)} — Focus`;
  }

  function setRunning(nextRunning) {
    running = nextRunning;
    startButton.classList.toggle('is-running', running);
    timerRing.classList.toggle('running', running);

    if (running) {
      startLabel.textContent = 'Pause timer';
      timerState.textContent = activeMode === 'focus' ? 'Stay with the task' : 'Enjoy your break';
      startButton.setAttribute('aria-label', 'Pause timer');
    } else {
      startLabel.textContent = remainingSeconds === totalSeconds ? modes[activeMode].startLabel : 'Resume timer';
      timerState.textContent = remainingSeconds === totalSeconds ? 'Ready when you are' : 'Paused';
      startButton.setAttribute('aria-label', startLabel.textContent);
    }
  }

  function stopInterval() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function announce(id, message) {
    clearTimeout(statusTimer);
    statusRegion.replaceChildren();
    const status = document.createElement('span');
    status.className = 'inline-status';
    status.id = id;
    status.textContent = message;
    statusRegion.append(status);
    statusTimer = setTimeout(() => {
      if (status.isConnected) status.remove();
    }, 6000);
  }

  function finishSession() {
    stopInterval();
    setRunning(false);
    timerState.textContent = 'Session complete';
    announce('complete-confirmation', 'Session complete — well done!');
    if (activeMode === 'focus') {
      const count = document.querySelector('#completed-count');
      const minutes = document.querySelector('#focus-minutes');
      const completed = Number(count.textContent) + 1;
      count.textContent = String(completed);
      minutes.textContent = `${completed * modes.focus.minutes}m`;
    }
  }

  function toggleTimer() {
    if (running) {
      stopInterval();
      setRunning(false);
      announce('paused-indicator', 'Timer paused');
      return;
    }

    if (remainingSeconds <= 0) remainingSeconds = totalSeconds;
    setRunning(true);
    announce('running-indicator', activeMode === 'focus' ? 'Focus session is running' : 'Break timer is running');
    intervalId = setInterval(() => {
      remainingSeconds -= 1;
      renderTimer();
      if (remainingSeconds <= 0) finishSession();
    }, 1000);
  }

  function resetTimer() {
    stopInterval();
    remainingSeconds = totalSeconds;
    setRunning(false);
    renderTimer();
    announce('reset-confirmation', 'Timer reset and ready');
  }

  function applyMode(mode, announceChange = true) {
    activeMode = mode;
    stopInterval();
    totalSeconds = modes[mode].minutes * 60;
    remainingSeconds = totalSeconds;
    modeTitle.textContent = modes[mode].title;
    modeDescription.textContent = modes[mode].description;
    modeButtons.forEach(button => {
      const selected = button.dataset.mode === mode;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    setRunning(false);
    renderTimer();
    if (announceChange) {
      const names = { focus: 'Focus', short: 'Short break', long: 'Long break' };
      announce('mode-confirmation', `${names[mode]} timer selected`);
    }
  }

  startButton.addEventListener('click', toggleTimer);
  resetButton.addEventListener('click', resetTimer);
  skipButton.addEventListener('click', () => {
    const nextMode = activeMode === 'focus' ? 'short' : 'focus';
    applyMode(nextMode, false);
    announce('skip-confirmation', `Skipped to ${nextMode === 'focus' ? 'focus' : 'a short break'}`);
  });
  modeButtons.forEach(button => button.addEventListener('click', () => applyMode(button.dataset.mode)));

  function updateTaskSummary() {
    taskCount.textContent = `${taskTotal} ${taskTotal === 1 ? 'task' : 'tasks'}`;
    emptyState.classList.toggle('hidden', taskTotal > 0);
  }

  taskForm.addEventListener('submit', event => {
    event.preventDefault();
    const taskName = taskInput.value.trim();
    if (!taskName) return;

    const item = document.createElement('li');
    item.className = 'task-item';

    const check = document.createElement('button');
    check.className = 'task-check';
    check.type = 'button';
    check.setAttribute('aria-label', `Mark ${taskName} complete`);

    const text = document.createElement('span');
    text.className = 'task-text';
    text.textContent = taskName;

    const remove = document.createElement('button');
    remove.className = 'delete-task';
    remove.type = 'button';
    remove.setAttribute('aria-label', `Delete ${taskName}`);
    remove.textContent = '×';

    check.addEventListener('click', () => {
      item.classList.toggle('completed');
      check.setAttribute('aria-label', `${item.classList.contains('completed') ? 'Mark' : 'Mark'} ${taskName} ${item.classList.contains('completed') ? 'incomplete' : 'complete'}`);
    });

    remove.addEventListener('click', () => {
      item.remove();
      taskTotal -= 1;
      updateTaskSummary();
    });

    item.append(check, text, remove);
    taskList.append(item);
    taskTotal += 1;
    updateTaskSummary();
    taskInput.value = '';
    taskInput.focus();
  });

  soundToggle.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    soundToggle.classList.toggle('active', soundEnabled);
    soundToggle.setAttribute('aria-pressed', String(soundEnabled));
    soundToggle.setAttribute('aria-label', `Turn notification sound ${soundEnabled ? 'off' : 'on'}`);
    announce('sound-status', `Notification sound ${soundEnabled ? 'on' : 'off'}`);
  });

  themeToggle.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    announce('theme-confirmation', `${dark ? 'Light' : 'Dark'} theme enabled`);
  });

  document.addEventListener('keydown', event => {
    const target = event.target;
    const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (event.code === 'Space' && !isTyping) {
      event.preventDefault();
      toggleTimer();
    }
  });

  applyMode('focus', false);
  updateTaskSummary();
})();