# Pin Kamal so the staging deploy doesn't pull a fresh `latest` on every
# CI run — without this file, `gem install kamal` cost ~10-15s per push
# and an unrelated upstream Kamal release could change deploy behavior
# without a corresponding PR.
#
# This Gemfile is consumed by:
#   .github/workflows/deploy-staging.yml          (Deploy to Staging)
#   .github/workflows/staging-accessory-reboot.yml (Reboot Staging Accessory)
#
# Both invoke `ruby/setup-ruby@v1` with `bundler-cache: true`, which keys
# on `Gemfile.lock` and caches `vendor/bundle` between runs. Bumping
# Kamal: edit the version below, run `bundle update kamal`, commit both
# files. The action takes care of the rest.

source "https://rubygems.org"

gem "kamal", "~> 2.11"
