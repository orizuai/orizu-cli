export const instructionSetLockSchemaV1 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://orizu.ai/schemas/instruction-set-lock/v1",
  "title": "Orizu instruction set Lock v1",
  "type": "object",
  "required": [
    "lockfileVersion",
    "project",
    "instructionSets"
  ],
  "additionalProperties": false,
  "properties": {
    "lockfileVersion": {
      "const": 1
    },
    "project": {
      "type": "string",
      "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*$"
    },
    "instructionSets": {
      "type": "object",
      "additionalProperties": false,
      "patternProperties": {
        "^[a-z0-9]+(?:-[a-z0-9]+)*$": {
          "$ref": "#/$defs/instructionSet"
        }
      }
    },
    "helpers": {
      "type": "object",
      "propertyNames": {
        "pattern": "^helpers\\/(?!\\.{1,2}(?:\\/|$))(?!.*\\/\\.{1,2}(?:\\/|$))[A-Za-z0-9._-]+(?:\\/[A-Za-z0-9._-]+)*$"
      },
      "additionalProperties": {
        "$ref": "#/$defs/sha256"
      }
    },
    "pins": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "type": "string",
        "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*/[^@\\s]+@v[1-9][0-9]*$"
      }
    }
  },
  "$defs": {
    "sha256": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "instructionSet": {
      "type": "object",
      "required": [
        "instructionSetId",
        "default",
        "profiles"
      ],
      "additionalProperties": false,
      "properties": {
        "instructionSetId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
        },
        "default": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9._-]*__[a-z0-9][a-z0-9._-]*$"
        },
        "profiles": {
          "type": "object",
          "minProperties": 1,
          "additionalProperties": false,
          "patternProperties": {
            "^[a-z0-9][a-z0-9._-]*__[a-z0-9][a-z0-9._-]*$": {
              "$ref": "#/$defs/profile"
            }
          }
        }
      }
    },
    "profile": {
      "type": "object",
      "required": [
        "production",
        "versions"
      ],
      "additionalProperties": false,
      "properties": {
        "production": {
          "type": [
            "string",
            "null"
          ],
          "pattern": "^v[1-9][0-9]*$"
        },
        "versions": {
          "type": "object",
          "minProperties": 1,
          "additionalProperties": false,
          "patternProperties": {
            "^v[1-9][0-9]*$": {
              "$ref": "#/$defs/version"
            }
          }
        }
      }
    },
    "version": {
      "type": "object",
      "required": [
        "profileVersionId",
        "versionNumber",
        "digest",
        "components",
        "syncedAt"
      ],
      "additionalProperties": false,
      "properties": {
        "profileVersionId": {
          "type": "string",
          "format": "uuid",
          "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
        },
        "versionNumber": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        },
        "digest": {
          "$ref": "#/$defs/sha256"
        },
        "components": {
          "type": "object",
          "minProperties": 1,
          "propertyNames": {
            "pattern": "^(?!\\.)[A-Za-z0-9._-]+$"
          },
          "additionalProperties": {
            "$ref": "#/$defs/sha256"
          }
        },
        "syncedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^(?:(?:[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8])))|(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:00|0[48]|[2468][048]|[13579][26])00)-02-29))T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$"
        }
      }
    }
  }
} as const
