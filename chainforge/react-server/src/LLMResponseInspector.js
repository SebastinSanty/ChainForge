/**
 * An inspector UI for examining LLM responses.
 * 
 * Separated from ReactFlow node UI so that it can 
 * be deployed in multiple locations.  
 */
import React, { useState, useEffect, useRef } from 'react';
import { Collapse, Flex, MultiSelect, NativeSelect } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import * as XLSX from 'xlsx';
import useStore from './store';
import { filterDict } from './backend/utils';

// Helper funcs
const truncStr = (s, maxLen) => {
  if (s.length > maxLen) // Cut the name short if it's long
      return s.substring(0, maxLen) + '...'
  else
      return s;
};
const groupResponsesBy = (responses, keyFunc) => {
  let responses_by_key = {};
  let unspecified_group = [];
  responses.forEach(item => {
      const key = keyFunc(item);
      const d = key !== null ? responses_by_key : unspecified_group;
      if (key in d)
          d[key].push(item);
      else
          d[key] = [item];
  });
  return [responses_by_key, unspecified_group];
};
const countResponsesBy = (responses, keyFunc) => {
  let responses_by_key = {};
  let unspecified_group = [];
  responses.forEach(item => {
      const key = keyFunc(item);
      const d = key !== null ? responses_by_key : unspecified_group;
      if (key in d)
          d[key] += 1;
      else
          d[key] = 1;
  });
  return [responses_by_key, unspecified_group];
};
const getEvalResultStr = (eval_item) => {
  if (Array.isArray(eval_item)) {
      return 'scores: ' + eval_item.join(', ');
  }
  else if (typeof eval_item === 'object') {
      const strs = Object.keys(eval_item).map(key => {
          let val = eval_item[key];
          if (typeof val === 'number' && val.toString().indexOf('.') > -1)
              val = val.toFixed(4);  // truncate floats to 4 decimal places
          return `${key}: ${val}`;
      });
      return strs.join(', ');
  }
  else 
      return `score: ${eval_item}`;
};

// Export the JSON responses to an excel file (downloads the file):
export const exportToExcel = (jsonResponses, filename) => {
  if (!filename) filename = "responses.xlsx";

  // Check that there are responses to export:
  if (!jsonResponses || (Array.isArray(jsonResponses) && jsonResponses.length === 0)) {
      console.warn('No responses to export. Try connecting the inspector node to a prompt node or evaluator node.');
      return;
  }

  // We can construct the data as an array of JSON dicts, with keys as header names:
  // NOTE: We need to 'unwind' responses in each batch, since each res_obj can have N>1 responses.
  //       We will store every response text on a single row, but keep track of batches by creating a batch ID number.
  const data = jsonResponses.map((res_obj, res_obj_idx) => {
    const llm = res_obj.llm;
    const prompt = res_obj.prompt;
    const vars = res_obj.vars;
    const eval_res_items = res_obj.eval_res ? res_obj.eval_res.items : null;
    return res_obj.responses.map((r, r_idx) => {
      let row = { 'LLM': llm, 'Prompt': prompt, 'Response': r, 'Response Batch Id': res_obj_idx };
      Object.keys(vars).forEach(varname => {
        row[`Param: ${varname}`] = vars[varname];
      });
      if (eval_res_items && eval_res_items.length > r_idx) {
        const item = eval_res_items[r_idx];
        if (Array.isArray(item)) {
          row['Eval result'] = item.join(', ');
        }
        else if (typeof item === 'object') {
          Object.keys(item).forEach(key => {
              row[`Eval result: ${key}`] = item[key];
          });
        }
        else 
          row['Eval result'] = item;
      }
      return row;
    });
  }).flat();

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, filename);
};

const ResponseGroup = ({ header, responseBoxes, responseBoxesWrapperClass, displayStyle, defaultState }) => {
  const [opened, { toggle }] = useDisclosure(defaultState);

  return (<div>
    <div className='response-group-component-header' onClick={toggle}>{header}</div>
    <Collapse in={opened} transitionDuration={500} transitionTimingFunction='ease-in' animateOpacity={true}>
      <div className={responseBoxesWrapperClass} style={{display: displayStyle, flexWrap: 'wrap'}}>
          {responseBoxes}
      </div>
    </Collapse>
  </div>)
};


const LLMResponseInspector = ({ jsonResponses, wideFormat }) => {

  const [responses, setResponses] = useState([]);
  const [receivedResponsesOnce, setReceivedResponsesOnce] = useState(false);

  // The MultiSelect so people can dynamically set what vars they care about
  const [multiSelectVars, setMultiSelectVars] = useState([]);
  const [multiSelectValue, setMultiSelectValue] = useState([]);

  // Global lookup for what color to use per LLM
  const getColorForLLMAndSetIfNotFound = useStore((state) => state.getColorForLLMAndSetIfNotFound);

  // Update the visualization whenever the jsonResponses or MultiSelect values change:
  useEffect(() => {
    if (!jsonResponses || (Array.isArray(jsonResponses) && jsonResponses.length === 0))
      return;
    
    // Find all vars in responses
    let found_vars = new Set();
    jsonResponses.forEach(res_obj => {
      Object.keys(res_obj.vars).forEach(v => {
        found_vars.add(v);
      });
    });

    // Set the variables accessible in the MultiSelect for 'group by'
    let msvars = Array.from(found_vars).map(name => (
      // We add a $ prefix to mark this as a prompt parameter, and so 
      // in the future we can add special types of variables without name collisions
      {value: `${name}`, label: name} 
    )).concat({value: 'LLM', label: 'LLM'});
    setMultiSelectVars(msvars);
    
    // If this is the first time receiving responses, set the multiSelectValue to whatever is the first:
    if (!receivedResponsesOnce) {
      setMultiSelectValue([msvars[0].value]);
      setReceivedResponsesOnce(true);
    }

    const responses = jsonResponses;
    const selected_vars = multiSelectValue;

    // Functions to associate a color to each LLM in responses
    const color_for_llm = (llm) => (getColorForLLMAndSetIfNotFound(llm) + '99');
    const header_bg_colors = ['#e0f4fa', '#c0def9', '#a9c0f9', '#a6b2ea'];
    const response_box_colors = ['#eee', '#fff', '#eee', '#ddd', '#eee', '#ddd', '#eee'];
    const rgroup_color = (depth) => response_box_colors[depth % response_box_colors.length];

    const getHeaderBadge = (key, val, depth) => {
      if (val) {
        const s = truncStr(val.trim(), 1024);
        return (<div className="response-var-header" style={{backgroundColor: header_bg_colors[depth % header_bg_colors.length]}}>
          <span className="response-var-name">{key}&nbsp;=&nbsp;</span><span className="response-var-value">"{s}"</span>
        </div>);
      } else {
        return (<div className="response-var-header">{`unspecified ${key}`}</div>);
      }
    };

    // Now we need to perform groupings by each var in the selected vars list,
    // nesting the groupings (preferrably with custom divs) and sorting within 
    // each group by value of that group's var (so all same values are clumped together).
    // :: For instance, for varnames = ['LLM', '$var1', '$var2'] we should get back 
    // :: nested divs first grouped by LLM (first level), then by var1, then var2 (deepest level).
    let leaf_id = 0;
    let first_opened = false;
    const groupByVars = (resps, varnames, eatenvars, header) => {
        if (resps.length === 0) return [];
        if (varnames.length === 0) {
            // Base case. Display n response(s) to each single prompt, back-to-back:
            let fixed_width = 100;
            if (wideFormat && eatenvars.length > 0) {
              const num_llms = Array.from(new Set(resps.map(res_obj => res_obj.llm))).length;
              fixed_width = Math.max(20, Math.trunc(100 / num_llms)) - 1; // 20% width is lowest we will go (5 LLM response boxes max)
            }
            const resp_boxes = resps.map((res_obj, res_idx) => {

                const eval_res_items = res_obj.eval_res ? res_obj.eval_res.items : null;

                // Bucket responses that have the same text, and sort by the 
                // number of same responses so that the top div is the most prevalent response.
                // We first need to keep track of the original evaluation result per response str:
                let resp_str_to_eval_res = {};
                if (eval_res_items)
                  res_obj.responses.forEach((r, idx) => {
                    resp_str_to_eval_res[r] = eval_res_items[idx]
                  });
                const same_resp_text_counts = countResponsesBy(res_obj.responses, (r) => r)[0];
                const same_resp_keys = Object.keys(same_resp_text_counts).sort((key1, key2) => (same_resp_text_counts[key2] - same_resp_text_counts[key1]));

                // Spans for actual individual response texts
                const ps = same_resp_keys.map((r, idx) => (
                  <div key={idx}>
                    {same_resp_text_counts[r] > 1 ? 
                      (<span className="num-same-responses">{same_resp_text_counts[r]} times</span>)
                    : <></>}
                    {eval_res_items ? (
                      <p className="small-response-metrics">{getEvalResultStr(resp_str_to_eval_res[r])}</p>
                    ) : <></>}
                    <pre className="small-response">{r}</pre>
                  </div>
                ));

                // At the deepest level, there may still be some vars left over. We want to display these
                // as tags, too, so we need to display only the ones that weren't 'eaten' during the recursive call:
                // (e.g., the vars that weren't part of the initial 'varnames' list that form the groupings)
                const unused_vars = filterDict(res_obj.vars, v => !eatenvars.includes(v));
                const var_tags = Object.keys(unused_vars).map((varname) => {
                    const v = truncStr(unused_vars[varname].trim(), wideFormat ? 72 : 18);
                    return (<div key={varname} className="response-var-inline" >
                      <span className="response-var-name">{varname}&nbsp;=&nbsp;</span><span className="response-var-value">{v}</span>
                    </div>);
                });
                return (
                    <div key={"r"+res_idx} className="response-box" style={{ backgroundColor: color_for_llm(res_obj.llm), width: `${fixed_width}%` }}>
                        <div className="response-var-inline-container">
                          {var_tags}
                        </div>
                        {eatenvars.includes('LLM') ?
                              ps
                            : (<div className="response-item-llm-name-wrapper">
                               <h1>{res_obj.llm}</h1>
                                {ps}
                               
                              </div>)
                        }
                    </div>
                );
            });
            const className = eatenvars.length > 0 ? "response-group" : "";
            const boxesClassName = eatenvars.length > 0 ? "response-boxes-wrapper" : "";
            const flexbox = (wideFormat && fixed_width < 100) ? 'flex' : 'block';
            const defaultOpened = !first_opened || eatenvars.length === 0 || eatenvars[eatenvars.length-1] === 'LLM';
            first_opened = true;
            leaf_id += 1;
            return (
                <div key={'l'+leaf_id} className={className} style={{ backgroundColor: rgroup_color(eatenvars.length) }}>
                  <ResponseGroup header={header} 
                                 responseBoxes={resp_boxes} 
                                 responseBoxesWrapperClass={boxesClassName} 
                                 displayStyle={flexbox} 
                                 defaultState={defaultOpened} />   
                </div>
            );
        }

        // Bucket responses by the first var in the list, where
        // we also bucket any 'leftover' responses that didn't have the requested variable (a kind of 'soft fail')
        const group_name = varnames[0];
        const [grouped_resps, leftover_resps] = (group_name === 'LLM') 
                                                ? groupResponsesBy(resps, (r => r.llm)) 
                                                : groupResponsesBy(resps, (r => ((group_name in r.vars) ? r.vars[group_name] : null)));
        const get_header = (group_name === 'LLM') 
                            ? ((key, val) => (<div key={val} style={{backgroundColor: color_for_llm(val)}} className='response-llm-header'>{val}</div>))
                            : ((key, val) => getHeaderBadge(key, val, eatenvars.length));
        
        // Now produce nested divs corresponding to the groups
        const remaining_vars = varnames.slice(1);
        const updated_eatenvars = eatenvars.concat([group_name]);
        const defaultOpened = !first_opened || eatenvars.length === 0 || eatenvars[eatenvars.length-1] === 'LLM';
        const grouped_resps_divs = Object.keys(grouped_resps).map(g => groupByVars(grouped_resps[g], remaining_vars, updated_eatenvars, get_header(group_name, g)));
        const leftover_resps_divs = leftover_resps.length > 0 ? groupByVars(leftover_resps, remaining_vars, updated_eatenvars, get_header(group_name, undefined)) : [];

        leaf_id += 1;

        return (<div key={'h'+ group_name + '_' + leaf_id}>
            {header ? 
                (<div key={group_name} className="response-group" style={{ backgroundColor: rgroup_color(eatenvars.length) }}>
                  <ResponseGroup header={header} 
                                 responseBoxes={grouped_resps_divs} 
                                 responseBoxesWrapperClass="response-boxes-wrapper"
                                 displayStyle="block"
                                 defaultState={defaultOpened} />
                </div>)
                : <div key={group_name}>{grouped_resps_divs}</div>}
            {leftover_resps_divs.length === 0 ? (<></>) : (
                <div key={'__unspecified_group'} className="response-group">
                    {leftover_resps_divs}
                </div>
            )}
        </div>);
    };

    // Produce DIV elements grouped by selected vars
    const divs = groupByVars(responses, selected_vars, [], null);
    setResponses(divs);

  }, [multiSelectValue, jsonResponses, wideFormat]);

  // When the user clicks an item in the drop-down,
  // we want to autoclose the multiselect drop-down:
  const multiSelectRef = useRef(null);
  const handleMultiSelectValueChange = (new_val) => {
    if (multiSelectRef) {
      multiSelectRef.current.blur();
    }
    setMultiSelectValue(new_val);
  };

  return (<div style={{height: '100%'}}>
    {/* <Flex> */}
      {/* <NativeSelect label='View as' data={['Hierarchy', 'Table']} mr='8px' w='15%' /> */}
      <MultiSelect ref={multiSelectRef}
                  onChange={handleMultiSelectValueChange}
                  className='nodrag nowheel inspect-multiselect'
                  label={<span style={{marginTop: '0px', fontWeight: 'normal'}}>Group responses by (order matters):</span>}
                  data={multiSelectVars}
                  placeholder="Pick vars to group responses, in order of importance"
                  size={wideFormat ? 'sm' : 'xs'}
                  value={multiSelectValue}
                  clearSearchOnChange={true}
                  clearSearchOnBlur={true}
                  w='100%' />
    {/* </Flex> */}
    <div className="nowheel nodrag">
      {responses}
    </div>
  </div>);
};

export default LLMResponseInspector;