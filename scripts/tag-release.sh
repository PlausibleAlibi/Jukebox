#!/bin/bash
#
# tag-release.sh
# 
# Interactive script for managing Git tags and releases with semantic versioning.
#
# Features:
#   - Interactive prompts for version number with validation
#   - Option to specify release type (major, minor, patch)
#   - Automatic tag creation with annotation
#   - Push tags to remote repository
#   - Generate release notes template
#   - Comprehensive error handling and confirmation prompts
#
# Usage:
#   ./tag-release.sh
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

# Validate semantic version format (e.g., v1.2.3 or 1.2.3)
validate_semver() {
    local version=$1
    # Remove leading 'v' if present
    version=${version#v}
    
    if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        return 1
    fi
    return 0
}

# Parse semantic version into components
parse_semver() {
    local version=$1
    # Remove leading 'v' if present
    version=${version#v}
    
    IFS='.' read -r MAJOR MINOR PATCH <<< "$version"
}

# Increment version based on release type
increment_version() {
    local current_version=$1
    local release_type=$2
    
    # Remove leading 'v' if present
    current_version=${current_version#v}
    
    parse_semver "$current_version"
    
    case $release_type in
        major)
            MAJOR=$((MAJOR + 1))
            MINOR=0
            PATCH=0
            ;;
        minor)
            MINOR=$((MINOR + 1))
            PATCH=0
            ;;
        patch)
            PATCH=$((PATCH + 1))
            ;;
        *)
            print_error "Invalid release type: $release_type"
            return 1
            ;;
    esac
    
    echo "v${MAJOR}.${MINOR}.${PATCH}"
}

# Get the latest tag
get_latest_tag() {
    local latest_tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
    if [ -z "$latest_tag" ]; then
        echo "v0.0.0"
    else
        echo "$latest_tag"
    fi
}

# Main script
echo "========================================"
echo "Party Jukebox Release Tagging Tool"
echo "========================================"
echo ""

# Check if we're in a git repository
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    print_error "Not a git repository. Please run this script from within the repository."
    exit 1
fi

# Check if there are uncommitted changes
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    print_warning "You have uncommitted changes in your working directory."
    read -p "Do you want to continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_info "Tagging cancelled."
        exit 0
    fi
fi

# Get the latest tag
LATEST_TAG=$(get_latest_tag)
print_info "Latest tag: $LATEST_TAG"
echo ""

# Ask user how they want to specify the version
echo "How would you like to specify the new version?"
echo "  1) Enter version number manually"
echo "  2) Auto-increment (major, minor, or patch)"
echo ""
read -p "Choose an option (1 or 2): " VERSION_OPTION

NEW_VERSION=""

if [ "$VERSION_OPTION" == "1" ]; then
    # Manual version entry
    while true; do
        read -p "Enter new version number (e.g., 1.2.3 or v1.2.3): " NEW_VERSION
        
        if validate_semver "$NEW_VERSION"; then
            # Ensure version starts with 'v'
            NEW_VERSION=${NEW_VERSION#v}
            NEW_VERSION="v${NEW_VERSION}"
            break
        else
            print_error "Invalid version format. Please use semantic versioning (e.g., 1.2.3)."
        fi
    done
elif [ "$VERSION_OPTION" == "2" ]; then
    # Auto-increment
    echo ""
    echo "Select release type:"
    echo "  1) Major (breaking changes): $LATEST_TAG -> $(increment_version "$LATEST_TAG" "major")"
    echo "  2) Minor (new features):     $LATEST_TAG -> $(increment_version "$LATEST_TAG" "minor")"
    echo "  3) Patch (bug fixes):        $LATEST_TAG -> $(increment_version "$LATEST_TAG" "patch")"
    echo ""
    read -p "Choose release type (1-3): " RELEASE_TYPE
    
    case $RELEASE_TYPE in
        1)
            NEW_VERSION=$(increment_version "$LATEST_TAG" "major")
            ;;
        2)
            NEW_VERSION=$(increment_version "$LATEST_TAG" "minor")
            ;;
        3)
            NEW_VERSION=$(increment_version "$LATEST_TAG" "patch")
            ;;
        *)
            print_error "Invalid selection."
            exit 1
            ;;
    esac
else
    print_error "Invalid option."
    exit 1
fi

echo ""
print_info "New version: $NEW_VERSION"

# Check if tag already exists
if git rev-parse "$NEW_VERSION" >/dev/null 2>&1; then
    print_error "Tag $NEW_VERSION already exists."
    exit 1
fi

# Generate release notes template
RELEASE_NOTES_FILE=$(mktemp)
cat > "$RELEASE_NOTES_FILE" << EOF
# Release $NEW_VERSION

## Changes
- 

## Bug Fixes
- 

## New Features
- 

## Breaking Changes
- 

---
# Please edit the release notes above. Lines starting with '#' will be kept.
# Save and close the editor to continue, or delete all content to cancel.
EOF

# Ask user to edit release notes
echo ""
print_info "Opening editor for release notes..."
echo ""
${EDITOR:-nano} "$RELEASE_NOTES_FILE"

# Check if release notes were provided
if [ ! -s "$RELEASE_NOTES_FILE" ] || ! grep -q '^[^#]' "$RELEASE_NOTES_FILE"; then
    print_warning "No release notes provided. Tagging cancelled."
    rm -f "$RELEASE_NOTES_FILE"
    exit 0
fi

# Extract non-comment lines for the tag annotation
TAG_MESSAGE=$(grep -v '^#' "$RELEASE_NOTES_FILE" | grep -v '^---$' | sed '/^$/N;/^\n$/D')

# Show summary
echo ""
echo "========================================"
echo "Release Summary"
echo "========================================"
echo "Version: $NEW_VERSION"
echo "Previous: $LATEST_TAG"
echo ""
echo "Release Notes:"
echo "$TAG_MESSAGE"
echo ""
echo "========================================"
echo ""

# Final confirmation
read -p "Create and push this tag? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_info "Tagging cancelled."
    rm -f "$RELEASE_NOTES_FILE"
    exit 0
fi

# Create annotated tag
print_info "Creating tag $NEW_VERSION..."
if git tag -a "$NEW_VERSION" -m "$TAG_MESSAGE"; then
    print_success "Tag created successfully."
else
    print_error "Failed to create tag."
    rm -f "$RELEASE_NOTES_FILE"
    exit 1
fi

# Ask to push tag to remote
echo ""
read -p "Push tag to remote? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_info "Pushing tag to remote..."
    
    # Get default remote (usually 'origin')
    DEFAULT_REMOTE=$(git remote | head -n 1)
    
    if git push "$DEFAULT_REMOTE" "$NEW_VERSION"; then
        print_success "Tag pushed to remote successfully."
    else
        print_error "Failed to push tag to remote."
        print_info "You can push it manually later with: git push $DEFAULT_REMOTE $NEW_VERSION"
        rm -f "$RELEASE_NOTES_FILE"
        exit 1
    fi
fi

# Cleanup
rm -f "$RELEASE_NOTES_FILE"

echo ""
echo "========================================"
print_success "Release $NEW_VERSION completed successfully!"
echo "========================================"
echo ""
print_info "Next steps:"
echo "  - Create a GitHub release from this tag"
echo "  - Update CHANGELOG.md (if applicable)"
echo "  - Notify users of the new release"
echo ""
