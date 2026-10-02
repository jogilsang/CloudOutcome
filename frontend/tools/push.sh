#!/bin/sh
set -eu
cd "$(git rev-parse --show-toplevel)"
if ! command -v git-remote-codecommit >/dev/null 2>&1; then
  echo 'git-remote-codecommit is required; install the AWS-supported helper in an approved environment.' >&2
  exit 1
fi
export AWS_PROFILE="${AWS_PROFILE:?set AWS_PROFILE to your AWS CLI profile}"
export AWS_DEFAULT_REGION=us-east-1
export GIT_TERMINAL_PROMPT=0
python3 tools/check_policy.py
git push -u origin "$(git branch --show-current)"
