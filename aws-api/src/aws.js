const glob = require('glob');
const {
  GraphQLServer
} = require('graphql-yoga');
const {
  inputObjectType,
  objectType,
  queryField,
  extendType,
  arg,

  makeSchema
} = require('nexus');
const AWS = require('aws-sdk');

const typeMatching = {
  'blob': 'string',
  'long': 'int',
  'string': 'string',
  'integer': 'int',
  'timestamp': 'int',
  'boolean': 'boolean',
  [undefined]: 'string'
};

const extractShape = () => {};

function removeDuplicates(myArr, prop) {
  return myArr.filter((obj, pos, arr) => {
    return arr.map(mapObj => mapObj[prop]).indexOf(obj[prop]) === pos;
  });
}

const extractType = ({
  parentName,
  type,
  shapes,
  isInput = false
}) => {
  if (!type) {
    return [];
  }

  const name = `${parentName}${isInput ? 'InputType' : ''}`;
  const nestedTypes = [];

  const {
    required,
    shape,
    members = [],
  } = type;

  const typeBuilder = isInput ? inputObjectType : objectType;


  if (shape) {
    const shapedType = shapes[shape];

    return [
      ...extractType({
        parentName,
        type: shapedType,
        shapes,
      }),
      ...nestedTypes
    ];
  }

  for (const memberName in members) {
    if (members.hasOwnProperty(memberName)) {
      const field = members[memberName];

      if (field.type === 'structure' || field.type === 'list') {
        nestedTypes.push(
          ...extractType({
            parentName: memberName,
            type: field.type === 'list' ? field.member : field,
            shapes,
          })
        );
      }
    }
  }

  const computedType = typeBuilder({
    name,
    definition(t) {
      let fieldCount = 0;

      for (const memberName in members) {
        if (members.hasOwnProperty(memberName)) {
          const field = members[memberName];
          const {
            type = 'string'
          } = field;
          const isRequired = required && required.includes(memberName);

          if (t[typeMatching[type]]) {
            t[typeMatching[type]](memberName, {
              required: isRequired
            });
          } else {
            t.field(memberName, {
              type: memberName,
              required: isRequired,
              list: type === 'list'
            });
          }

          fieldCount++;
        }
      }

      if (!fieldCount) {
        t.string('ok', {
          resolve: () => 'ok'
        });
      }
    },
  });

  return [
    computedType,
    ...nestedTypes
  ]
}

const extractApi = ({
  operations,
  shapes,
}) => {
  const payload = {
    types: [],
    queries: []
  };

  for (const operationName in operations) {
    const operation = operations[operationName];

    // console.log(operationName, operation.http.method);

    if (operation.http) {
      const {
        method
      } = operation.http;

      if (method === 'GET') {
        payload.types.push(
          ...extractType({
            parentName: operationName,
            type: operation.input,
            shapes,
            isInput: true,
          })
        );
      }
    }

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
            t.string('ok', () => ({}))
          }
        })
      );
    }

    const args = {};


    if (operation.input && operation.input.members) {
      for (const memberName in operation.input.members) {
        const member = operation.input.members[memberName];

        if (typeMatching[member.type]) {
          args[memberName] = arg({
            type: "String",
            required: false
          });
        } else {
          console.log(operationName, memberName, member.type)
          // args[memberName] = arg({
          //   type: `${memberName}InputType`,
          //   required: false
          // });
        }
      }
    }

    payload.queries.push(
      queryField(operationName, {
        args: args,
        type: operationName,
        resolve: () => ({})
      })
    );
  }

  // console.log(payload);

  return payload;
};

const readApis = (apiNames) => {
  const apis = glob.sync("node_modules/aws-sdk/apis/*.min.json");

  const dataApis = {
    types: [],
    queries: [],
    mutations: []
  };

  for (const apiFile of apis) {
    const api = require(apiFile.replace("node_modules/", ""));
    const {
      metadata,
      operations,
      shapes,
      version
    } = api;


    if (
      !apiNames.includes(metadata.endpointPrefix) ||
      (dataApis[metadata.endpointPrefix] &&
        metadata.apiVersion <
        dataApis[metadata.endpointPrefix].metadata.apiVersion)
    ) {
      continue;
    }


    const {
      types,
      queries,
      // mutations
    } = extractApi(api);

    console.log(queries[0].config);

    dataApis.types = [
      ...dataApis.types,
      ...types
    ];

    dataApis.queries = [
      ...dataApis.queries,
      ...queries
    ];
  }

  return makeSchema({
    types: [
      extendType({
        type: "Query",
        definition(t) {
          t.string('sdkVersion', {
            nullable: true,
            resolve: () => AWS.VERSION
          })
          // for (const query of dataApis.queries) {
          //   t.field(query);

          //   console.log(query);
          // }
        }
      }),
      ...dataApis.queries,
      ...(removeDuplicates(dataApis.types, 'name'))
    ],

    outputs: false,
  });
}

const schema = readApis([
  's3'
]);

const server = new GraphQLServer({
  schema
});

server.start(() => console.log('server listen'));