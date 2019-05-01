const glob = require("glob");
const { GraphQLServer } = require("graphql-yoga");
const {
  inputObjectType,
  objectType,
  queryField,
  extendType,
  scalarType,
  arg,

  makeSchema
} = require("nexus");
const AWS = require("aws-sdk");

AWS.config.update({
  region: "us-east-1"
});

const typeMatching = {
  blob: "string",
  double: "int",
  long: "int",
  map: "json",
  float: "int",
  string: "string",
  integer: "int",
  timestamp: "string",
  boolean: "boolean",
  [undefined]: "JSON"
};

function removeDuplicates(myArr, prop) {
  return myArr.filter((obj, pos, arr) => {
    return arr.map((mapObj) => mapObj[prop]).indexOf(obj[prop]) === pos;
  });
}

const extractType = ({ parentName, type, shapes, isInput = false }) => {
  if (!type) return [];

  const name = `${parentName}${isInput ? "InputType" : ""}`;
  const nestedTypes = [];

  const { required, shape, members = [] } = type;

  const typeBuilder = isInput ? inputObjectType : objectType;

  if (shape) {
    return [
      ...extractType({
        parentName,
        type: shapes[shape],
        shapes,
        isInput
      }),
      ...nestedTypes
    ];
  }

  for (const memberName in members) {
    if (members.hasOwnProperty(memberName)) {
      const field = members[memberName];

      if (field.type === "structure" || field.type === "list" || field.shape) {
        nestedTypes.push(
          ...extractType({
            parentName: `${memberName}`,
            type: field.type === "list" ? field.member : field,
            shapes,
            isInput
          })
        );
      }
    }
  }

  const computedType = typeBuilder({
    name,
    nullable: true,
    definition(t) {
      let fieldCount = 0;

      for (const memberName in members) {
        if (members.hasOwnProperty(memberName)) {
          const field = members[memberName];
          const isRequired = !!required && required.includes(memberName);
          let type = field.shape ? memberName : field.type || "string";

          let config;

          if (t[typeMatching[type]]) {
            config = {
              required: isRequired
            };
          } else {
            config = {
              type: `${memberName}${isInput ? "InputType" : ""}`,
              required: isRequired,
              list: type === "list"
            };
          }

          t[typeMatching[type] || "field"](
            memberName,
            Object.assign(config, !isInput ? { nullable: !isRequired } : {})
          );

          fieldCount++;
        }
      }

      if (!fieldCount) t.string("ok", () => "ok");
    }
  });

  return [computedType, ...nestedTypes];
};

const extractApi = ({ metadata, operations, shapes }) => {
  const payload = {
    types: [],
    fields: [],
    endpoints: []
  };

  for (const operationName in operations) {
    const operation = operations[operationName];

    payload.types.push(
      ...extractType({
        parentName: operationName,
        type: operation.input,
        shapes,
        isInput: true
      })
    );

    if (operation.output) {
      payload.types.push(
        ...extractType({
          parentName: operationName,
          type: operation.output,
          shapes
        })
      );
    } else {
      payload.types.push(
        objectType({
          name: operationName,
          definition(t) {
            t.string("ok", () => ({}));
          }
        })
      );
    }

    payload.endpoints.push({
      name: operationName,
      nullable: true,
      config: {
        args: operation.input
          ? {
              data: arg({
                type: `${operationName}InputType`
              })
            }
          : {},
        type: operationName,
        resolve: async (parent, args) => {
          const serviceInstance = new AWS[metadata.serviceId]();
          const functionName = `${operationName[0].toLowerCase()}${operationName.slice(
            1
          )}`;

          return await serviceInstance[functionName](args).promise();
        }
      }
    });
  }

  payload.types.push(
    objectType({
      name: metadata.endpointPrefix,
      nullable: true,
      definition(t) {
        for (const endpoint of payload.endpoints) {
          t.field(endpoint.name, endpoint.config);
        }
      }
    })
  );

  payload.api = queryField(metadata.endpointPrefix, {
    type: metadata.endpointPrefix,
    nullable: true,
    resolve: () => ({})
  });

  return payload;
};

const readApis = (apiNames) => {
  const apis = glob.sync("node_modules/aws-sdk/apis/*.min.json");

  const dataApis = {
    types: [],
    apis: []
  };

  for (const apiFile of apis) {
    const api = require(apiFile.replace("node_modules/", ""));
    const { metadata, operations, shapes, version } = api;

    if (
      !apiNames.includes(metadata.endpointPrefix) ||
      (dataApis[metadata.endpointPrefix] &&
        metadata.apiVersion <
          dataApis[metadata.endpointPrefix].metadata.apiVersion)
    ) {
      continue;
    }

    const { types, api: extractedApi } = extractApi(api);

    dataApis.types = [...dataApis.types, ...types];
    dataApis.apis = [...dataApis.apis, extractedApi];
  }

  return makeSchema({
    types: [
      extendType({
        type: "Query",
        definition(t) {
          t.string("sdkVersion", {
            nullable: true,
            resolve: () => AWS.VERSION
          });
        }
      }),
      scalarType({
        name: "JSON",
        asNexusMethod: "json",
        parseValue: (value) =>
          typeof value === "string" ? JSON.stringify(value) : value,
        serialize: (value) =>
          typeof value === "string" ? JSON.stringify(value) : value,
        parseLiteral() {
          return null;
        }
      }),
      ...dataApis.apis,
      ...removeDuplicates(dataApis.types, "name")
    ],

    outputs: false
  });
};

const schema = readApis(["ec2", "s3", "textract", "iam"]);

const server = new GraphQLServer({
  schema
});

server.start(() => console.log("server listen"));
