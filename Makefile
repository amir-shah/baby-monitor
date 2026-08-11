# babymon
#
# Two audiences share this file. On a developer machine `make dev`, `make test`
# and `make lint` are the whole workflow; on the Pi, `make install` and
# `make backup` are. Targets that only make sense in one place say so.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

REPO      := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
PI_DIR    := $(REPO)/pi
VENV      := $(PI_DIR)/.venv
PY        := $(VENV)/bin/python
PIP       := $(VENV)/bin/pip
PYTEST    := $(VENV)/bin/pytest
RUFF      := $(VENV)/bin/ruff
MYPY      := $(VENV)/bin/mypy

DASHBOARD := $(REPO)/dashboard
HOMEKIT   := $(REPO)/homekit

# Where a deployed instance keeps its data. Override for a non-default install:
#     make backup DATA_DIR=/mnt/ssd/babymon
DATA_DIR  ?= /var/lib/babymon
CONF_DIR  ?= /etc/babymon
DB        ?= $(DATA_DIR)/babymon.db
BACKUP_DIR ?= $(DATA_DIR)/backups

.PHONY: help install dev test test-all lint lint-fix typecheck build dashboard \
        homekit clean backup restore-check models check services logs fmt

# ---------------------------------------------------------------------------

help: ## Show this help
	@printf '\nbabymon — make targets\n\n'
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk -F':.*?## ' '{printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'
	@printf '\n'

# ---------------------------------------------------------------------------
# Deployment (on the Pi)
# ---------------------------------------------------------------------------

install: ## Full system install: services, venv, dashboard, bridge (needs sudo, Pi)
	sudo $(REPO)/deploy/install.sh

models: ## Download the YAMNet model into the data directory
	sudo $(REPO)/deploy/fetch-models.sh --dest $(DATA_DIR)/models

services: ## Status of the three systemd units
	@systemctl --no-pager --lines=0 status \
		babymon-mediamtx babymon-api babymon-homekit || true

logs: ## Follow all three service logs together
	@journalctl -f -u babymon-mediamtx -u babymon-api -u babymon-homekit

backup: ## VACUUM INTO a dated copy of the database (safe while running)
	@test -f "$(DB)" || { echo "no database at $(DB) — set DB= or DATA_DIR="; exit 1; }
	@mkdir -p "$(BACKUP_DIR)"
	@stamp=$$(date +%Y%m%d-%H%M%S); \
	dest="$(BACKUP_DIR)/babymon-$$stamp.db"; \
	sqlite3 "$(DB)" "VACUUM INTO '$$dest'"; \
	echo "wrote $$dest ($$(du -h "$$dest" | cut -f1))"; \
	echo "integrity: $$(sqlite3 "$$dest" 'PRAGMA integrity_check')"
	@printf '\nNote: this backs up the database only — the sleep history, events,\n'
	@printf 'notes and tags. It does NOT include $(DATA_DIR)/media (snapshots and\n'
	@printf 'clips) or $(DATA_DIR)/hap (HomeKit pairing keys). Copy those separately\n'
	@printf 'if you want a restore that does not require re-pairing.\n'

# ---------------------------------------------------------------------------
# Development
# ---------------------------------------------------------------------------

dev: $(VENV)/bin/activate ## Create the dev venv and install everything editable
	@printf '\nvenv ready. Run the service against a local config with:\n'
	@printf '  $(PY) -m babymon run --config config/babymon.yaml\n'
	@printf 'and the dashboard dev server (proxies /api to :8080) with:\n'
	@printf '  make -C $(DASHBOARD) dev   # or: cd dashboard && npm run dev\n\n'

$(VENV)/bin/activate: $(PI_DIR)/pyproject.toml
	# --system-site-packages on a Pi so the apt-installed python3-picamera2 is
	# visible; harmless everywhere else, where there is nothing to inherit.
	python3 -m venv --system-site-packages $(VENV)
	$(PIP) install --quiet --upgrade pip setuptools wheel
	$(PIP) install --quiet -e "$(PI_DIR)[dev,audio]"
	@touch $(VENV)/bin/activate

test: $(VENV)/bin/activate ## Run the Python test suite
	cd $(PI_DIR) && $(PYTEST)

test-all: $(VENV)/bin/activate ## Python tests plus the HomeKit bridge tests
	cd $(PI_DIR) && $(PYTEST) --cov=babymon --cov-report=term-missing
	cd $(HOMEKIT) && npm test

lint: $(VENV)/bin/activate ## ruff check + ESLint on the dashboard
	cd $(PI_DIR) && $(RUFF) check .
	@if [ -d $(DASHBOARD)/node_modules ]; then cd $(DASHBOARD) && npm run lint; \
	 else echo "skipping dashboard lint: run 'make dashboard' first"; fi

# ruff's linter only. `ruff format` is deliberately not wired in: this codebase
# hand-aligns a lot of tables and constant blocks for readability and the
# formatter would flatten them.
fmt: $(VENV)/bin/activate ## Apply ruff's autofixes (including import order)
	cd $(PI_DIR) && $(RUFF) check --fix .

lint-fix: fmt ## Alias for fmt

typecheck: $(VENV)/bin/activate ## mypy on Python, tsc on the bridge and dashboard
	cd $(PI_DIR) && $(MYPY) babymon
	@if [ -d $(HOMEKIT)/node_modules ]; then cd $(HOMEKIT) && npm run typecheck; \
	 else echo "skipping bridge typecheck: run 'make homekit' first"; fi
	@if [ -d $(DASHBOARD)/node_modules ]; then cd $(DASHBOARD) && npm run typecheck; \
	 else echo "skipping dashboard typecheck: run 'make dashboard' first"; fi

check: lint typecheck test ## Everything CI would run

# ---------------------------------------------------------------------------
# Builds
# ---------------------------------------------------------------------------

build: dashboard homekit ## Build both front ends

dashboard: ## Build the web dashboard into dashboard/dist
	cd $(DASHBOARD) && { [ -f package-lock.json ] && npm ci --no-audit --no-fund \
		|| npm install --no-audit --no-fund; }
	cd $(DASHBOARD) && npm run build
	@echo "built $(DASHBOARD)/dist — point paths.static_dir at it, or run 'make install'"

homekit: ## Build the HomeKit bridge into homekit/dist
	cd $(HOMEKIT) && { [ -f package-lock.json ] && npm ci --no-audit --no-fund \
		|| npm install --no-audit --no-fund; }
	cd $(HOMEKIT) && npm run build
	@echo "built $(HOMEKIT)/dist"

# ---------------------------------------------------------------------------

clean: ## Remove build output, caches and the dev venv
	rm -rf $(VENV)
	rm -rf $(DASHBOARD)/dist $(DASHBOARD)/node_modules
	rm -rf $(HOMEKIT)/dist $(HOMEKIT)/node_modules
	rm -rf $(PI_DIR)/.pytest_cache $(PI_DIR)/.mypy_cache $(PI_DIR)/.ruff_cache
	rm -rf $(PI_DIR)/build $(PI_DIR)/*.egg-info $(PI_DIR)/.coverage $(PI_DIR)/htmlcov
	find $(PI_DIR) -name __pycache__ -type d -prune -exec rm -rf {} +
	@printf '\nNothing under $(DATA_DIR) or $(CONF_DIR) was touched — clean never\n'
	@printf 'deletes data or configuration. Use deploy/uninstall.sh for that.\n'
