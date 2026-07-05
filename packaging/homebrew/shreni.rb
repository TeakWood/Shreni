# Homebrew formula for Shreni (DRAFT — see packaging/RELEASING.md).
#
# This installs the published npm package as a CLI. It cannot be finalised until
# Shreni is published to npm, because the `url` points at the npm tarball and the
# `sha256` is that tarball's checksum. To generate a ready-to-tap formula after
# `npm publish`:
#
#   1. Publish to npm (see packaging/RELEASING.md).
#   2. Run:  brew create --tap <you>/homebrew-shreni \
#              https://registry.npmjs.org/shreni/-/shreni-<version>.tgz
#      Homebrew downloads the tarball, computes the sha256, and scaffolds a
#      formula you can reconcile against this template.
#   3. Fill in the `url` version and `sha256` below and commit it to your tap
#      repo (a GitHub repo named `homebrew-shreni`), so users can:
#           brew install <you>/shreni/shreni
#
# Requires Node at runtime (Shreni drives your provider CLI, which is separate).

require "language/node"

class Shreni < Formula
  desc "Local-first, bring-your-own-model agent harness for reviewed, merged code"
  homepage "https://github.com/TeakWood/Shreni"
  url "https://registry.npmjs.org/shreni/-/shreni-0.1.0.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256_AFTER_NPM_PUBLISH"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    # `shreni` with no args prints usage and exits non-zero; assert the banner.
    output = shell_output("#{bin}/shreni 2>&1", 1)
    assert_match "shreni", output
  end
end