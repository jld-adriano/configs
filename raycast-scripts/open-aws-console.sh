#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title open aws console
# @raycast.mode compact

# Optional parameters:
# @raycast.icon :cloud:

export PATH=$PATH:/Users/jldadriano/.nix-profile/bin
age-env run-with-env eawst -- aws-console  --duration 1h --region us-west-2 --browser
